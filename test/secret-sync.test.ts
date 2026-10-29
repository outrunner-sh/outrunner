import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { MAX_ENV_BYTES } from "@/lib/environments/rules";
import { SyncError } from "@/lib/secret-sync/providers";
import {
  dopplerTokenKind,
  mergeSyncedEnv,
  secretPath,
  SecretSyncRuleError,
  slug,
  variableSources,
} from "@/lib/secret-sync/rules";
import { syncSecrets, type SyncDeps } from "@/lib/secret-sync/sync";

test("a Doppler token's kind is read from its prefix", () => {
  assert.equal(dopplerTokenKind("dp.st.dev.abcdefgh1234"), "service");
  assert.equal(dopplerTokenKind("dp.pt.abcdefgh1234"), "account");
  assert.equal(dopplerTokenKind("dp.sa.abcdefgh1234"), "account");
  assert.equal(dopplerTokenKind("dp.scim.abcdefgh1234"), null);
  assert.equal(dopplerTokenKind("sk-abcdefgh1234"), null);
  assert.equal(dopplerTokenKind("dp.st.short"), null);
});

test("slugs and secret paths are read as posted, or refused", () => {
  assert.equal(slug("  backend ", "Project"), "backend");
  assert.equal(slug("", "Project"), null);
  assert.equal(slug(undefined, "Project"), null);
  assert.throws(() => slug("a b", "Project"), SecretSyncRuleError);
  assert.throws(() => slug("../x", "Project"), SecretSyncRuleError);
  assert.equal(secretPath("apps/api/"), "/apps/api");
  assert.equal(secretPath("/"), null);
  assert.equal(secretPath(""), null);
  assert.throws(() => secretPath("/a/../b"), SecretSyncRuleError);
  assert.throws(() => secretPath("/a b"), SecretSyncRuleError);
});

test("the project's own variables win a name, Infisical's win over Doppler's", () => {
  const { env, outcomes } = mergeSyncedEnv({ SHARED: "project" }, [
    { provider: "doppler", env: { SHARED: "doppler", BOTH: "doppler", ONLY_D: "d" } },
    { provider: "infisical", env: { SHARED: "infisical", BOTH: "infisical", ONLY_I: "i" } },
  ]);
  assert.deepEqual(env, { SHARED: "project", BOTH: "infisical", ONLY_D: "d", ONLY_I: "i" });
  assert.deepEqual(outcomes.get("doppler"), { names: ["BOTH", "ONLY_D", "SHARED"], skipped: [], tooLarge: false });
});

test("a synced name a session can't set is skipped, as the project's own would be refused", () => {
  const { env, outcomes } = mergeSyncedEnv({}, [
    { provider: "doppler", env: { PATH: "/evil", ANTHROPIC_API_KEY: "x", RUNTIME_TOKEN: "x", "BAD-NAME": "x", NUL: "a\0b", OK: "1" } },
  ]);
  assert.deepEqual(env, { OK: "1" });
  assert.deepEqual(outcomes.get("doppler")?.skipped, ["ANTHROPIC_API_KEY", "BAD-NAME", "NUL", "PATH", "RUNTIME_TOKEN"]);
});

test("secrets that would take the environment past what a session takes are left out, the last provider's first", () => {
  const big = { BIG: "x".repeat(MAX_ENV_BYTES) };
  const { env, outcomes } = mergeSyncedEnv({ OWN: "1" }, [
    { provider: "doppler", env: { SMALL: "1" } },
    { provider: "infisical", env: big },
  ]);
  assert.deepEqual(env, { SMALL: "1", OWN: "1" });
  assert.equal(outcomes.get("infisical")?.tooLarge, true);
  assert.equal(outcomes.get("doppler")?.tooLarge, false);
});

test("the page lists each variable's source, and what a shadowed one loses to", () => {
  assert.deepEqual(
    variableSources(["A", "Z"], [
      { provider: "doppler", names: ["A", "B", "C"] },
      { provider: "infisical", names: ["B"] },
    ]),
    [
      { name: "A", source: "project", shadowedBy: null },
      { name: "A", source: "doppler", shadowedBy: "project" },
      { name: "B", source: "doppler", shadowedBy: "infisical" },
      { name: "B", source: "infisical", shadowedBy: null },
      { name: "C", source: "doppler", shadowedBy: null },
      { name: "Z", source: "project", shadowedBy: null },
    ],
  );
});

// ---------------------------------------------------------------------------
// A session starting

type Link = { provider: "doppler" | "infisical" };
type Recorded = { provider: string; error: string | null; names: string[]; skipped: string[] };

const VALUE = "hunter2-very-secret";
let logged: string[] = [];
const realConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };
beforeEach(() => {
  logged = [];
  for (const level of ["error", "warn", "log", "info"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});
afterEach(() => Object.assign(console, realConsole));

function deps(
  links: Link[],
  fetch: SyncDeps<Link>["fetch"],
): { deps: SyncDeps<Link>; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    deps: {
      links: async () => links,
      fetch,
      record: async (provider, result) => {
        recorded.push({ provider, ...result });
      },
      timeoutMs: 200,
    },
  };
}

test("a session gets its linked secrets fetched now, beneath its project's own", async () => {
  const { deps: d, recorded } = deps([{ provider: "doppler" }], async () => ({ env: { API: VALUE, OWN: "doppler" }, cli: null }));
  const result = await syncSecrets(d, { env: { OWN: "project" }, startHook: "make dev" });
  assert.deepEqual(result.env, { API: VALUE, OWN: "project" });
  assert.equal(result.startHook, "make dev", "no CLI to install for Doppler");
  assert.deepEqual(recorded, [{ provider: "doppler", error: null, names: ["API", "OWN"], skipped: [] }]);
  assert.ok(!logged.join("\n").includes(VALUE));
});

test("a provider outage or a revoked token doesn't stop the session: it starts with the rest, and the error is recorded", async () => {
  const { deps: d, recorded } = deps([{ provider: "doppler" }, { provider: "infisical" }], async (link) => {
    if (link.provider === "doppler") throw new SyncError("Doppler refused the token: it may have been revoked.", true);
    return { env: { FROM_INFISICAL: VALUE }, cli: { INFISICAL_TOKEN: "at" } };
  });
  const result = await syncSecrets(d, { env: { OWN: "1" }, startHook: null });
  assert.deepEqual(result.env, { INFISICAL_TOKEN: "at", FROM_INFISICAL: VALUE, OWN: "1" });
  assert.match(recorded.find((r) => r.provider === "doppler")!.error!, /revoked/);
  assert.deepEqual(recorded.find((r) => r.provider === "infisical"), {
    provider: "infisical",
    error: null,
    names: ["FROM_INFISICAL"],
    skipped: [],
  });
  assert.ok(!logged.join("\n").includes(VALUE));
});

test("a provider that hangs is given up on at the timeout", async () => {
  const { deps: d, recorded } = deps([{ provider: "doppler" }], (_link, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new SyncError("Doppler didn't answer in time.", false)));
    }),
  );
  const started = Date.now();
  const result = await syncSecrets(d, { env: { OWN: "1" }, startHook: null });
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(result.env, { OWN: "1" });
  assert.match(recorded[0].error!, /in time/);
});

test("an unexpected error is recorded in Outrunner's words, never its own (which could quote a value)", async () => {
  const { deps: d, recorded } = deps([{ provider: "infisical" }], async () => {
    throw new Error(`boom ${VALUE}`);
  });
  const result = await syncSecrets(d, { env: {}, startHook: null });
  assert.deepEqual(result.env, {});
  assert.match(recorded[0].error!, /Couldn't sync Infisical/);
  assert.ok(!recorded[0].error!.includes(VALUE));
  assert.ok(!logged.join("\n").includes(VALUE));
});

test("Infisical's CLI sign-in comes with its secrets, and its install goes before the project's start hook", async () => {
  const { deps: d } = deps([{ provider: "infisical" }], async () => ({
    env: { INFISICAL_PROJECT_ID: "from-the-folder" },
    cli: { INFISICAL_TOKEN: "at", INFISICAL_PROJECT_ID: "p1" },
  }));
  const result = await syncSecrets(d, { env: { INFISICAL_TOKEN: "project-own" }, startHook: "docker compose up -d" });
  // The folder's secret over the CLI's, the project's own over both.
  assert.deepEqual(result.env, { INFISICAL_TOKEN: "project-own", INFISICAL_PROJECT_ID: "from-the-folder" });
  assert.match(result.startHook!, /Infisical\/cli\/releases\/download\/v[\d.]+\/cli_[\d.]+_linux_\$arch\.tar\.gz/);
  assert.ok(result.startHook!.endsWith("\n\ndocker compose up -d"));
});

test("no links, or links that can't be read, leave the session as it was", async () => {
  const none = deps([], async () => ({ env: {}, cli: null }));
  assert.deepEqual(await syncSecrets(none.deps, { env: { A: "1" }, startHook: "x" }), { env: { A: "1" }, startHook: "x", outcomes: [] });

  const broken: SyncDeps<Link> = {
    links: async () => {
      throw new Error("relation does not exist");
    },
    fetch: async () => ({ env: {}, cli: null }),
    record: async () => {},
  };
  assert.deepEqual(await syncSecrets(broken, { env: { A: "1" }, startHook: null }), { env: { A: "1" }, startHook: null, outcomes: [] });
});

test("a sync that can't be recorded still gives the session its secrets", async () => {
  const d: SyncDeps<Link> = {
    links: async () => [{ provider: "doppler" }],
    fetch: async () => ({ env: { A: VALUE }, cli: null }),
    record: async () => {
      throw new Error("database down");
    },
  };
  assert.deepEqual((await syncSecrets(d, { env: {}, startHook: null })).env, { A: VALUE });
  assert.ok(!logged.join("\n").includes(VALUE));
});
