import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeProxy } from "@/lib/claude/inference";
import {
  authorizeClaude,
  ClaudeAccessError,
  type ClaudeGrant,
} from "@/lib/claude/access";
import { createCodexProxy } from "@/lib/codex/inference";
import { CodexError } from "@/lib/codex/account";
import { quotaExhausted } from "@/lib/agents/quota-fallback";

const claude: ClaudeGrant = {
  purpose: "claude-inference",
  user: "alice",
  org: "team",
  primary: { kind: "personal", id: "alice", revision: "own-1" },
  fallback: { kind: "org", id: "team", revision: "shared-1" },
};
const ctx = (path: string) => ({
  params: Promise.resolve({ path: path.split("/") }),
});
const request = (path: string) =>
  new Request(`https://app.example/api/runtime/${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-grant",
      "anthropic-beta": "claude-code-20250219",
      "x-api-key": "must-not-forward",
      "x-codex-turn-state": "personal-account-routing-state",
    },
    body: '{"model":"opus","stream":true,"messages":[{"role":"user","content":"continue"}]}',
  });

for (const agent of ["claude", "codex"] as const) {
  function fixture(statuses: number[], fallback = true) {
    let member = true;
    let primaryConnected = true;
    const calls: { account: string; body: string; headers: Headers }[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        account: headers.get(
          agent === "claude" ? "authorization" : "chatgpt-account-id",
        )!,
        body: new TextDecoder().decode(init!.body as ArrayBuffer),
        headers,
      });
      const status = statuses.shift() ?? 200;
      if (status === 0) throw new TypeError("Network unavailable");
      return new Response(
        status === 200
          ? "data: success\n\n"
          : '{"error":{"type":"rate_limit_error"}}',
        {
          status,
          headers: {
            "content-type":
              status === 200 ? "text/event-stream" : "application/json",
            "retry-after": "120",
          },
        },
      );
    };
    const proxy =
      agent === "claude"
        ? createClaudeProxy({
            readGrant: () => ({
              ...claude,
              fallback: fallback ? claude.fallback : undefined,
            }),
            authorize: async (_g, ref) => {
              if (!member || !primaryConnected) throw new ClaudeAccessError();
              return ref.kind === "personal"
                ? "sk-ant-oat-own"
                : "sk-ant-oat-shared";
            },
            fetch: fetcher,
          })
        : createCodexProxy({
            readGrant: () => ({
              purpose: "codex-inference",
              user: "alice",
              org: "team",
              key: "personal:alice",
              generation: "own-1",
              ...(fallback
                ? { fallback: { key: "org:team", generation: "shared-1" } }
                : {}),
            }),
            authorize: async () => {
              if (!member || !primaryConnected)
                throw new CodexError("revoked", "Revoked");
            },
            accounts: {
              access: async (key) => ({
                revision: 1,
                tokens: {
                  access_token: key,
                  account_id: key,
                  refresh_token: "unused",
                  id_token: "unused",
                },
              }),
            },
            fetch: fetcher,
          });
    return {
      calls,
      removeMember: () => {
        member = false;
      },
      disconnect: () => {
        primaryConnected = false;
      },
      run: () =>
        proxy(
          request(
            `${agent}/${agent === "claude" ? "v1/messages" : "responses"}`,
          ),
          ctx(agent === "claude" ? "v1/messages" : "responses"),
        ),
    };
  }
  test(`${agent}: a quota rejection switches personal → org with the same body and streams the answer once`, async () => {
    const f = fixture([429, 200, 200]);
    const result = await f.run();
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "data: success\n\n");
    assert.equal(f.calls.length, 2);
    assert.notEqual(f.calls[0].account, f.calls[1].account);
    assert.equal(f.calls[0].body, f.calls[1].body);
    assert.equal(f.calls[1].headers.get("x-api-key"), null);
    assert.equal(f.calls[1].headers.get("x-codex-turn-state"), null);
    if (agent === "claude")
      assert.match(
        f.calls[1].headers.get("anthropic-beta")!,
        /oauth-2025-04-20/,
      );
    assert.equal((await f.run()).status, 200);
    assert.equal(f.calls.length, 3);
    assert.equal(
      f.calls[2].account,
      f.calls[1].account,
      "cooldown keeps using the fallback",
    );
    f.removeMember();
    assert.equal((await f.run()).status, 403);
    assert.equal(f.calls.length, 3);
  });
  test(`${agent}: disconnecting the original connection revokes fallback access too`, async () => {
    const f = fixture([429, 200]);
    await (await f.run()).text();
    f.disconnect();
    assert.equal((await f.run()).status, 403);
    assert.equal(f.calls.length, 2);
  });
  test(`${agent}: two exhausted accounts stop after one fallback`, async () => {
    const f = fixture([429, 429]);
    const result = await f.run();
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "120");
    assert.equal(f.calls.length, 2);
    await result.text();
  });
  for (const status of [200, 400, 403, 500])
    test(`${agent}: HTTP ${status} never switches accounts or replays a successful stream`, async () => {
      const f = fixture([status]);
      assert.equal((await f.run()).status, status);
      assert.equal(f.calls.length, 1);
    });
  test(`${agent}: network errors never switch accounts`, async () => {
    const f = fixture([0]);
    assert.equal((await f.run()).status, 503);
    assert.equal(f.calls.length, 1);
  });
  test(`${agent}: authentication errors never switch accounts`, async () => {
    const f = fixture([401, 401]);
    assert.equal((await f.run()).status, agent === "claude" ? 401 : 403);
    assert.equal(f.calls.length, agent === "claude" ? 1 : 2);
    assert.ok(f.calls.every((call) => call.account === f.calls[0].account));
  });
  test(`${agent}: without a fallback, return the quota error unchanged`, async () => {
    const f = fixture([429], false);
    assert.equal((await f.run()).status, 429);
    assert.equal(f.calls.length, 1);
  });
}

test("Claude grants reject another user/org, removed membership and replaced credentials", async () => {
  let member = true;
  const rows = new Map([
    ["personal:alice", { revision: "own-1", token: "sk-ant-oat-own" }],
    ["org:team", { revision: "shared-1", token: "sk-ant-oat-shared" }],
  ]);
  const deps = {
    member: async () => member,
    read: async (r: ClaudeGrant["primary"]) =>
      rows.get(`${r.kind}:${r.id}`) ?? null,
  };
  assert.equal(
    await authorizeClaude(claude, claude.fallback!, deps),
    "sk-ant-oat-shared",
  );
  await assert.rejects(
    authorizeClaude({ ...claude, user: "bob" }, claude.primary, deps),
    ClaudeAccessError,
  );
  await assert.rejects(
    authorizeClaude({ ...claude, org: "other" }, claude.fallback!, deps),
    ClaudeAccessError,
  );
  await assert.rejects(
    authorizeClaude(claude, { ...claude.fallback!, revision: "forged" }, deps),
    ClaudeAccessError,
  );
  rows.set("org:team", { revision: "shared-2", token: "sk-ant-oat-new" });
  await assert.rejects(
    authorizeClaude(claude, claude.fallback!, deps),
    ClaudeAccessError,
  );
  rows.delete("personal:alice");
  await assert.rejects(
    authorizeClaude(claude, claude.primary, deps),
    ClaudeAccessError,
  );
  member = false;
  await assert.rejects(
    authorizeClaude(claude, claude.primary, deps),
    ClaudeAccessError,
  );
});
test("quota classification recognizes billing errors without treating every forbidden response as quota", async () => {
  for (const code of [
    "usage_limit_reached",
    "insufficient_quota",
    "billing_hard_limit_reached",
  ])
    assert.equal(
      await quotaExhausted(Response.json({ error: { code } }, { status: 403 })),
      true,
    );
  assert.equal(
    await quotaExhausted(
      Response.json({ error: { code: "permission_denied" } }, { status: 403 }),
    ),
    false,
  );
});
