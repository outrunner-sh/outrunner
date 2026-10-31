import assert from "node:assert/strict";
import { test } from "node:test";

import { authorize, boxSetupRefusal, boxSetupRefused, wantedOrg, type ApiAuthDeps } from "@/lib/api/auth";
import { hashApiKey } from "@/lib/api/keys";
import type { StoredApiKey } from "@/lib/db/api-keys";
import type { OrgRole } from "@/lib/orgs/active";

const ORG = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const KEY = `or_key_${"k".repeat(43)}`;
const CLI = `or_cli_${"c".repeat(43)}`;

function deps({
  key,
  roles = { [ORG]: "admin", [PERSONAL]: "admin" },
  allowed = true,
}: {
  key?: Partial<StoredApiKey>;
  roles?: Record<string, OrgRole>;
  allowed?: boolean;
} = {}): ApiAuthDeps {
  return {
    async findKey(hash) {
      if (!key || hash !== hashApiKey(KEY)) return null;
      return { id: "key1", orgId: null, userId: "u1", expiresAt: null, revokedAt: null, ...key };
    },
    async findCliToken(hash) {
      return hash === hashApiKey(CLI) ? { id: "cli1", userId: "u1" } : null;
    },
    async memberOrgId(_userId, wanted) {
      if (!wanted) return PERSONAL;
      return { acme: ORG, other: OTHER }[wanted.toLowerCase()] ?? (wanted === ORG ? ORG : null);
    },
    async memberRole(orgId) {
      return roles[orgId] ?? null;
    },
    async allowed() {
      return allowed;
    },
    now: () => Date.parse("2026-11-01T00:00:00Z"),
  };
}

test("no credential is told where to make one", async () => {
  const auth = await authorize(null, null, deps());
  assert.equal(auth.ok, false);
  assert.equal(!auth.ok && auth.status, 401);
});

test("an org key acts as its maker, in its org", async () => {
  const auth = await authorize({ kind: "api_key", secret: KEY }, null, deps({ key: { orgId: ORG } }));
  assert.deepEqual(auth, {
    ok: true,
    caller: { kind: "org_key", userId: "u1", orgId: ORG, role: "admin", keyId: "key1", cliTokenId: null },
  });
});

test("an org key stops once its maker is no longer an admin", async () => {
  const auth = await authorize({ kind: "api_key", secret: KEY }, null, deps({ key: { orgId: ORG }, roles: { [ORG]: "member" } }));
  assert.equal(auth.ok, false);
  assert.equal(!auth.ok && auth.status, 401);
});

test("an org key naming another org is refused, not moved", async () => {
  const auth = await authorize({ kind: "api_key", secret: KEY }, "other", deps({ key: { orgId: ORG }, roles: { [ORG]: "admin", [OTHER]: "admin" } }));
  assert.equal(!auth.ok && auth.status, 403);
  const same = await authorize({ kind: "api_key", secret: KEY }, "acme", deps({ key: { orgId: ORG } }));
  assert.equal(same.ok, true);
});

test("a personal key goes where ?org= says, else the personal org", async () => {
  const personal = await authorize({ kind: "api_key", secret: KEY }, null, deps({ key: {} }));
  assert.equal(personal.ok && personal.caller.orgId, PERSONAL);
  assert.equal(personal.ok && personal.caller.kind, "personal_key");
  const named = await authorize({ kind: "api_key", secret: KEY }, "acme", deps({ key: {}, roles: { [ORG]: "member" } }));
  assert.equal(named.ok && named.caller.orgId, ORG);
  assert.equal(named.ok && named.caller.role, "member");
  const nowhere = await authorize({ kind: "api_key", secret: KEY }, "nope", deps({ key: {} }));
  assert.equal(!nowhere.ok && nowhere.status, 404);
});

test("revoked, expired and unknown keys say which", async () => {
  const revoked = await authorize({ kind: "api_key", secret: KEY }, null, deps({ key: { revokedAt: "2026-10-01T00:00:00Z" } }));
  assert.match(!revoked.ok ? revoked.message : "", /revoked/);
  const expired = await authorize({ kind: "api_key", secret: KEY }, null, deps({ key: { expiresAt: "2026-10-01T00:00:00Z" } }));
  assert.match(!expired.ok ? expired.message : "", /expired/);
  const unknown = await authorize({ kind: "api_key", secret: `or_key_${"x".repeat(43)}` }, null, deps({ key: {} }));
  assert.equal(!unknown.ok && unknown.status, 401);
});

test("the CLI's token works as a personal key", async () => {
  const auth = await authorize({ kind: "cli_token", secret: CLI }, null, deps());
  assert.deepEqual(auth.ok && auth.caller, { kind: "cli_token", userId: "u1", orgId: PERSONAL, role: "admin", keyId: null, cliTokenId: "cli1" });
});

test("a maker the allowlist no longer lets in is refused", async () => {
  const auth = await authorize({ kind: "cli_token", secret: CLI }, null, deps({ allowed: false }));
  assert.equal(!auth.ok && auth.status, 401);
});

test("the org is named by ?org= or the Outrunner-Org header", () => {
  assert.equal(wantedOrg(new Request("https://x.test/api/v1/me?org=acme")), "acme");
  assert.equal(wantedOrg(new Request("https://x.test/api/v1/me", { headers: { "outrunner-org": " acme " } })), "acme");
  assert.equal(wantedOrg(new Request("https://x.test/api/v1/me")), null);
});

test("only an org key changes what runs on the project's boxes", () => {
  assert.equal(boxSetupRefusal("org_key"), null);
  assert.match(boxSetupRefusal("personal_key") ?? "", /org key/);
  assert.match(boxSetupRefusal("cli_token") ?? "", /org key/);
});

test("a refusal is the API's 403", async () => {
  assert.equal(boxSetupRefused({ caller: { kind: "org_key" } }), null);
  const refused = boxSetupRefused({ caller: { kind: "personal_key" } });
  assert.equal(refused?.status, 403);
  assert.match(((await refused?.json()) as { error: { message: string } }).error.message, /MCP servers, skills/);
});
