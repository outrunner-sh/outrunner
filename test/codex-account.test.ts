import { createCodexManagement } from "@/lib/codex/management";
import { boundedBody } from "@/lib/codex/body";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  CodexAccounts,
  CodexError,
  codexLogin,
  metadata,
  renewCodex,
  type CodexStore,
  type CodexTokens,
  type Connection,
  type Operation,
} from "@/lib/codex/account";
import { checkCodexGrant, selectCodexAccount } from "@/lib/codex/access";
import { createCodexProxy } from "@/lib/codex/inference";

const jwt = (exp: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.synthetic`;
const tokens = (expired = false): CodexTokens => ({
  access_token: jwt(Date.now() / 1000 + (expired ? -60 : 3600)),
  id_token: jwt(1234),
  refresh_token: "synthetic-refresh-secret",
  account_id: "account-one",
});
// Model the DB's atomic compare-and-set operations; the SQL integration test
// exercises those same fences against PostgreSQL, not this stand-in.
class MemoryStore implements CodexStore {
  rows = new Map<string, Connection>();
  locks = new Map<string, string>();
  async read(key: string) {
    return structuredClone(this.rows.get(key) ?? null);
  }
  async change(
    key: string,
    op: Operation,
    a: Record<string, string | number> = {},
  ) {
    let r = this.rows.get(key);
    if (!r) {
      r = {
        key,
        generation: randomUUID(),
        revision: 0,
        status: "disconnected",
        ciphertext: null,
        updated_at: new Date().toISOString(),
        pending_id: null,
        pending_user: null,
        pending_until: null,
      };
      this.rows.set(key, r);
    }
    let claimed = false;
    if (op === "begin")
      Object.assign(r, {
        pending_id: a.attempt,
        pending_user: a.actor,
        pending_until: new Date(Date.now() + 600000).toISOString(),
      });
    if (op === "cancel" && r.pending_id === a.attempt) r.pending_id = null;
    if (
      op === "save" &&
      r.pending_id === a.attempt &&
      r.pending_user === a.actor &&
      Date.parse(r.pending_until!) > Date.now()
    ) {
      Object.assign(r, {
        generation: randomUUID(),
        revision: r.revision + 1,
        status: "connected",
        ciphertext: a.ciphertext,
        pending_id: null,
      });
      this.locks.delete(key);
      claimed = true;
    }
    if (op === "disconnect") {
      Object.assign(r, {
        generation: randomUUID(),
        revision: r.revision + 1,
        status: "disconnected",
        ciphertext: null,
        pending_id: null,
      });
      this.locks.delete(key);
    }
    if (
      op === "lease" &&
      r.status === "connected" &&
      r.generation === a.generation &&
      r.revision === a.revision &&
      !this.locks.has(key)
    ) {
      this.locks.set(key, a.lease as string);
      claimed = true;
    }
    if (
      ["finish", "release", "reject"].includes(op) &&
      r.generation === a.generation &&
      this.locks.get(key) === a.lease
    ) {
      this.locks.delete(key);
      claimed = true;
      if (op === "finish")
        Object.assign(r, {
          ciphertext: a.ciphertext,
          revision: r.revision + 1,
        });
      if (op === "reject")
        Object.assign(r, {
          status: "reconnect",
          ciphertext: null,
          revision: r.revision + 1,
        });
    }
    return { row: structuredClone(r), claimed };
  }
}
function fixture(
  renew: (t: CodexTokens) => Promise<CodexTokens> = async () => tokens(),
) {
  const store = new MemoryStore();
  const crypto = {
    seal: (s: string) => Buffer.from(s).toString("base64url"),
    open: (s: string) => Buffer.from(s, "base64url").toString(),
  };
  const accounts = new CodexAccounts(
    store,
    crypto,
    renew,
    () => new Promise((r) => setTimeout(r, 1)),
  );
  async function connect(key = "org:one", expired = false) {
    const attempt = await accounts.begin(key, "admin");
    await accounts.save(key, "admin", attempt, tokens(expired));
    return (await store.read(key))!;
  }
  return { store, accounts, connect };
}

test("24 concurrent expired-token uses across controllers renew only once", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return tokens();
  });
  const row = await f.connect(undefined, true);
  const other = new CodexAccounts(
    f.store,
    f.accounts.crypto,
    f.accounts.renew,
    f.accounts.wait,
  );
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      (i % 2 ? other : f.accounts).access(row.key, row.generation),
    ),
  );
  assert.equal(calls, 1);
});
test("concurrent provider 401s refresh only the rejected revision once", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return tokens();
  });
  const row = await f.connect();
  await Promise.all(
    Array.from({ length: 12 }, () =>
      f.accounts.access(row.key, row.generation, row.revision),
    ),
  );
  assert.equal(calls, 1);
});
for (const operation of ["disconnect", "replace"] as const)
  test(`${operation} fences an in-flight refresh and every stale computer grant`, async () => {
    let finish!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((r) => {
      started = r;
    });
    const f = fixture(async () => {
      started();
      await new Promise<void>((r) => {
        finish = r;
      });
      return tokens();
    });
    const row = await f.connect(undefined, true);
    const use = f.accounts.access(row.key, row.generation);
    await waiting;
    if (operation === "replace") await f.connect();
    else await f.store.change(row.key, "disconnect");
    finish();
    await assert.rejects(
      use,
      (e: unknown) => e instanceof CodexError && e.code === "revoked",
    );
    await assert.rejects(f.accounts.access(row.key, row.generation));
    assert.equal(
      (await f.store.read(row.key))?.status,
      operation === "replace" ? "connected" : "disconnected",
    );
  });
test("cancel/expiry cannot reconnect after disconnect; replacing preserves the working account until success", async () => {
  const f = fixture();
  const row = await f.connect();
  const attempt = await f.accounts.begin(row.key, "admin");
  assert.equal((await f.store.read(row.key))?.generation, row.generation);
  await f.store.change(row.key, "cancel", { attempt });
  await assert.rejects(f.accounts.save(row.key, "admin", attempt, tokens()));
  const next = await f.accounts.begin(row.key, "admin");
  await f.store.change(row.key, "disconnect");
  await assert.rejects(f.accounts.save(row.key, "admin", next, tokens()));
  assert.equal(metadata(await f.store.read(row.key)).connected, false);
});
for (const permanent of [true, false])
  test(`${permanent ? "invalid_grant requires reconnect" : "transient errors keep the connection"}`, async () => {
    const f = fixture(async () => {
      throw new CodexError(permanent ? "reconnect" : "unavailable", "safe");
    });
    const row = await f.connect(undefined, true);
    await assert.rejects(f.accounts.access(row.key, row.generation));
    assert.equal(
      (await f.store.read(row.key))?.status,
      permanent ? "reconnect" : "connected",
    );
  });
test("ciphertext is bound to its owning scope, even if a row is copied", async () => {
  const f = fixture();
  const row = await f.connect();
  f.store.rows.set("org:two", { ...row, key: "org:two" });
  await assert.rejects(f.accounts.access("org:two", row.generation));
});
for (const status of [400, 401, 429, 500])
  test(`native refresh ${status} classification never exposes response/token`, async () => {
    const rejected = status === 400 || status === 401;
    await assert.rejects(
      renewCodex(tokens(), (async (_url, init) => {
        const b = JSON.parse(init!.body as string);
        assert.equal(b.grant_type, "refresh_token");
        assert.equal(b.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
        return Response.json(
          { error: "invalid_grant", secret: tokens().refresh_token },
          { status },
        );
      }) as typeof fetch),
      (e: unknown) =>
        e instanceof CodexError &&
        e.code === (rejected ? "reconnect" : "unavailable") &&
        !e.message.includes("synthetic"),
    );
  });
test("rotated refresh tokens persist, omitted id/refresh tokens are retained", async () => {
  const old = tokens();
  const access = jwt(Date.now() / 1000 + 3600);
  const next = await renewCodex(old, (async () =>
    Response.json({
      access_token: access,
      refresh_token: "rotated-refresh-token",
    })) as typeof fetch);
  assert.equal(next.refresh_token, "rotated-refresh-token");
  assert.equal(next.id_token, old.id_token);
  assert.equal(
    (
      await renewCodex(old, (async () =>
        Response.json({ access_token: access })) as typeof fetch)
    ).refresh_token,
    old.refresh_token,
  );
  assert.equal(
    codexLogin.safeParse({ tokens: { ...old, account_id: "bad\r\nheader" } })
      .success,
    false,
  );
});

test("two members use one org connection; removal, other org, disconnect and saved API choice deny future inference", async () => {
  const f = fixture();
  const row = await f.connect();
  const members = new Set(["alice", "bob"]);
  let pickedKey = false;
  let requests = 0;
  const response = createCodexProxy({
    readGrant: (user) => ({
      purpose: "codex-inference",
      user,
      org: "one",
      key: row.key,
      generation: row.generation,
    }),
    accounts: f.accounts,
    async authorize(g) {
      const current = await f.store.read(g.key);
      if (
        !members.has(g.user) ||
        pickedKey ||
        !current ||
        current.generation !== g.generation
      )
        throw new CodexError("revoked", "Unavailable");
    },
    fetch: (async (url, init) => {
      requests++;
      assert.equal(new URL(url as string).host, "chatgpt.com");
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("Authorization"),
        `Bearer ${f.accounts.decrypt((await f.store.read(row.key))!).access_token}`,
      );
      assert.equal(headers.get("ChatGPT-Account-ID"), "account-one");
      assert.equal(headers.get("content-encoding"), "zstd");
      return new Response("event: response.completed\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  });
  const use = (user: string) =>
    response(
      new Request("https://app.example/api/runtime/codex/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${user}`,
          "content-encoding": "zstd",
        },
        body: "synthetic-compressed",
      }),
      { params: Promise.resolve({ path: ["responses"] }) },
    );
  assert.equal((await use("alice")).status, 200);
  assert.equal((await use("bob")).status, 200);
  members.delete("bob");
  assert.equal((await use("bob")).status, 403);
  assert.equal((await use("other-org-member")).status, 403);
  pickedKey = true;
  assert.equal((await use("alice")).status, 403);
  pickedKey = false;
  await f.store.change(row.key, "disconnect");
  assert.equal((await use("alice")).status, 403);
  assert.equal(requests, 2);
});
test("membership removal while renewal waits prevents the upstream call", async () => {
  let removed = false;
  const f = fixture(async () => {
    removed = true;
    return tokens();
  });
  const row = await f.connect(undefined, true);
  const proxy = createCodexProxy({
    accounts: f.accounts,
    readGrant: () => ({
      purpose: "codex-inference",
      user: "alice",
      org: "one",
      key: row.key,
      generation: row.generation,
    }),
    authorize: async () => {
      if (removed) throw new CodexError("revoked", "Unavailable");
    },
    fetch: (async () => {
      assert.fail("must not call provider");
    }) as typeof fetch,
  });
  const result = await proxy(
    new Request("https://app/api/runtime/codex/models", {
      headers: { authorization: "Bearer alice" },
    }),
    { params: Promise.resolve({ path: ["models"] }) },
  );
  assert.equal(result.status, 403);
});

test("native account routing stays on the broker for personal and org connections and rejects revoked grants", async () => {
  for (const key of ["personal:alice", "org:one"]) {
    const f = fixture();
    const row = await f.connect(key);
    let allowed = true;
    const proxy = createCodexProxy({
      accounts: f.accounts,
      brokerOrigin: "https://app.example",
      readGrant: () => ({ purpose: "codex-inference", user: "alice", org: key.startsWith("org:") ? "one" : null, key, generation: row.generation }),
      authorize: async () => {
        if (!allowed) throw new CodexError("revoked", "Unavailable");
      },
      fetch: (async () => assert.fail("Routing must not expose or forward the provider account")) as typeof fetch,
    });
    const request = (path: string, method = "GET") => proxy(
      new Request(`http://internal:3000/api/runtime/codex/${path}`, { method, headers: { authorization: "Bearer alice" } }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    const routing = await request("api/codex/accounts/check");
    assert.equal(routing.status, 200);
    assert.equal(routing.headers.get("cache-control"), "no-store");
    assert.deepEqual(await routing.json(), { accounts: [{ id: "outrunner", workspace_backend_origin: "https://app.example", account_routing_override: "NO_CONSTRAINT" }] });
    for (const path of ["api/codex/tasks", "api/codex/config/bundle", "oauth/token"])
      assert.equal((await request(path)).status, 404);
    assert.equal((await request("api/codex/accounts/check", "POST")).status, 404);
    allowed = false;
    assert.equal((await request("api/codex/accounts/check")).status, 403);
    allowed = true;
    await f.store.change(key, "disconnect");
    assert.equal((await request("api/codex/accounts/check")).status, 403);
  }
});

test("actual scope resolver preserves personal/key precedence and checks current org membership after reading", async () => {
  const f = fixture();
  const shared = await f.connect("org:one");
  const members = new Set(["alice", "bob"]);
  const deps = {
    store: f.store,
    memberRole: async (org: string, user: string) =>
      org === "one" && members.has(user) ? "member" : null,
  };
  assert.equal(
    (await selectCodexAccount("alice", "one", false, false, deps))?.key,
    shared.key,
  );
  assert.equal(
    (await selectCodexAccount("bob", "one", false, false, deps))?.key,
    shared.key,
  );
  assert.equal(
    await selectCodexAccount("alice", "two", false, false, deps),
    null,
  );
  assert.equal(
    await selectCodexAccount("alice", "one", true, false, deps),
    null,
  );
  assert.equal(
    (await selectCodexAccount("alice", "one", true, true, deps))?.key,
    shared.key,
  );
  const own = await f.connect("personal:alice");
  assert.equal(
    (await selectCodexAccount("alice", "one", false, false, deps))?.key,
    own.key,
  );
  const selected = await selectCodexAccount("alice", "one", false, false, deps);
  assert.equal(selected && "fallback" in selected ? selected.fallback.key : null, shared.key);
  assert.equal(selected && "fallback" in selected ? selected.fallback.generation : null, shared.generation);
  const personalOnly = await selectCodexAccount("alice", undefined, false, false, deps);
  assert.ok(personalOnly && !("fallback" in personalOnly));
  const grant = {
    purpose: "codex-inference" as const,
    user: "bob",
    org: "one",
    key: shared.key,
    generation: shared.generation,
  };
  await checkCodexGrant(grant, deps);
  await assert.rejects(checkCodexGrant({ ...grant, org: "two" }, deps));
  await assert.rejects(
    checkCodexGrant(
      { ...grant, key: own.key, generation: own.generation },
      deps,
    ),
  );
  const removedDuringRead = {
    ...deps,
    store: {
      async read(key: string) {
        const row = await f.store.read(key);
        members.delete("bob");
        return row;
      },
    },
  };
  await assert.rejects(checkCodexGrant(grant, removedDuringRead));
});

test("management: only admins upload/share; metadata contains no tokens; canceled and cross-org attempts cannot upload", async () => {
  const f = fixture();
  const org = randomUUID();
  const other = randomUUID();
  let providerCalls = 0;
  const manage = createCodexManagement({
    accounts: f.accounts,
    store: f.store,
    memberRole: async (_org, user) =>
      user === "admin" ? "admin" : user === "member" ? "member" : null,
    fetch: (async (_url, init) => {
      providerCalls++;
      assert.equal(
        new Headers(init?.headers).get("ChatGPT-Account-ID"),
        "account-one",
      );
      return Response.json({ models: [] });
    }) as typeof fetch,
  });
  const req = (method: string) =>
    new Request("https://app/api/cli/codex", { method });
  assert.equal(
    (await manage(req("POST"), "member", org, { action: "begin" })).status,
    403,
  );
  assert.equal((await manage(req("GET"), "outsider", org)).status, 403);
  const begin = await (
    await manage(req("POST"), "admin", org, { action: "begin" })
  ).json();
  assert.ok(begin.attempt);
  assert.equal(begin.pending.mine, true);
  const teammate = await (await manage(req("GET"), "member", org)).json();
  assert.equal(teammate.pending.mine, false);
  assert.equal(
    (
      await manage(req("PUT"), "admin", other, {
        attempt: begin.attempt,
        tokens: tokens(),
      })
    ).status,
    403,
  );
  assert.equal(providerCalls, 0);
  assert.equal(
    (
      await manage(req("PUT"), "admin", org, {
        attempt: begin.attempt,
        tokens: tokens(),
      })
    ).status,
    200,
  );
  const meta = await (await manage(req("GET"), "member", org)).text();
  assert.equal(JSON.parse(meta).connected, true);
  assert.ok(
    !meta.includes("synthetic") &&
      !meta.includes("ciphertext") &&
      !meta.includes("generation"),
  );
  const replacement = await (
    await manage(req("POST"), "admin", org, { action: "begin" })
  ).json();
  assert.equal(
    (
      await manage(req("POST"), "admin", org, {
        action: "cancel",
        attempt: replacement.attempt,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await manage(req("PUT"), "admin", org, {
        attempt: replacement.attempt,
        tokens: tokens(),
      })
    ).status,
    403,
  );
  assert.equal(providerCalls, 1);
  assert.equal((await manage(req("DELETE"), "member", org)).status, 403);
});
test("management: disconnect/admin removal during provider verification fences a late login", async () => {
  for (const remove of [false, true]) {
    const f = fixture();
    const org = randomUUID();
    const key = `org:${org}`;
    let admin = true;
    const manage = createCodexManagement({
      accounts: f.accounts,
      store: f.store,
      memberRole: async () => (admin ? "admin" : null),
      fetch: (async () => {
        if (remove) admin = false;
        else await f.store.change(key, "disconnect");
        return Response.json({ models: [] });
      }) as typeof fetch,
    });
    const req = (method: string) =>
      new Request("https://app/api/cli/codex", { method });
    const begin = await (
      await manage(req("POST"), "admin", org, { action: "begin" })
    ).json();
    assert.equal(
      (
        await manage(req("PUT"), "admin", org, {
          attempt: begin.attempt,
          tokens: tokens(),
        })
      ).status,
      403,
    );
    assert.equal((await f.store.read(key))?.status, "disconnected");
  }
});
test("chunked bodies are bounded without trusting Content-Length", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(5));
      c.enqueue(new Uint8Array(8));
      c.close();
    },
  });
  const request = new Request("https://app", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.equal(await boundedBody(request, 10), null);
});
