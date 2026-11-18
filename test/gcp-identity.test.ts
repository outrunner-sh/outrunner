import { gcpSetupCommand } from "@/lib/runtime/gcp/setup-command";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { gcpAssertion, gcpIssuer, gcpJwks } from "@/lib/runtime/gcp/identity";
import { gcpNames, type GcpConnection } from "@/lib/runtime/gcp/config";
import { gcpRelayKey } from "@/lib/runtime/gcp/relay-ticket";
import { mintRelayTicket, relayTicketValid } from "@/lib/runtime/sandbox/relay-ticket";
const old = { key: process.env.CREDENTIALS_ENCRYPTION_KEY, base: process.env.RUNTIME_BASE_URL };
beforeEach(() => { process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64"); process.env.RUNTIME_BASE_URL = "https://app.example.com"; });
afterEach(() => { for (const [name, value] of [["CREDENTIALS_ENCRYPTION_KEY", old.key], ["RUNTIME_BASE_URL", old.base]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; } });
const c: GcpConnection = { id: "00000000-0000-4000-a000-000000000001", user_id: "owner", project_id: "sandbox-project", project_number: "123456789", zone: "us-central1-a", state: "connected", created_at: "", verified_at: null };
test("GCP identity is a verifiable five-minute, connection-scoped ES256 assertion, with public-only JWKS", () => {
  const jwt = gcpAssertion(c, 1_800_000_000_000); const [head, body, sig] = jwt.split("."); const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.sub, c.id); assert.equal(claims.aud, gcpNames(c).audience); assert.equal(claims.exp - claims.iat, 300); assert.equal(claims.iss, gcpIssuer());
  const jwk = gcpJwks().keys[0]; assert.equal("d" in jwk, false);
  assert.equal(verify("sha256", Buffer.from(`${head}.${body}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), true);
  assert.equal(verify("sha256", Buffer.from(`${head}.${body}tampered`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), false);
});
test("GCP identity is stable for replicas, changes with root-key rotation, and rejects revoked connections", () => {
  const key = gcpJwks(); assert.deepEqual(gcpJwks(), key); process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("hex"); assert.notDeepEqual(gcpJwks(), key);
  assert.throws(() => gcpAssertion({ ...c, state: "revoked" }), /disconnected/);
});
test("GCP refuses a non-public issuer or missing signing secret", () => {
  process.env.RUNTIME_BASE_URL = "http://localhost:3000"; assert.throws(() => gcpIssuer(), /HTTPS/);
  delete process.env.CREDENTIALS_ENCRYPTION_KEY; assert.throws(() => gcpJwks(), /ENCRYPTION_KEY/);
});
test("GCP relay tickets cannot be reused across providers, resources or ports", () => {
  const root = process.env.CREDENTIALS_ENCRYPTION_KEY!; const key = gcpRelayKey(root); const ticket = mintRelayTicket(c.id, 8080, key);
  assert.equal(relayTicketValid(ticket, c.id, 8080, key), true); assert.equal(relayTicketValid(ticket, c.id, 8080, root), false);
  assert.equal(relayTicketValid(ticket, "other", 8080, key), false); assert.equal(relayTicketValid(ticket, c.id, 3000, key), false);
});

test("the copied GCP command targets this deployment and the signed-in account", () => {
  assert.equal(gcpSetupCommand("https://app.outrunner.sh", c.id), `npx outrunner@latest --account '${c.id}' sandbox connect gcp`);
  assert.equal(gcpSetupCommand("https://self-hosted.example.com", c.id), `npx outrunner@latest --url 'https://self-hosted.example.com' --account '${c.id}' sandbox connect gcp`);
  assert.throws(() => gcpSetupCommand("https://app.example.com", "owner;whoami"));
  assert.throws(() => gcpSetupCommand("file:///etc/passwd"));
});
