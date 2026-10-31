import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { GcpApi, GcpError, gcpToken, googleJson } from "@/lib/runtime/gcp/api";
import { gcpNames, type GcpConnection } from "@/lib/runtime/gcp/config";
const saved = { key: process.env.CREDENTIALS_ENCRYPTION_KEY, base: process.env.RUNTIME_BASE_URL };
beforeEach(() => { process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("hex"); process.env.RUNTIME_BASE_URL = "https://app.example.com"; });
afterEach(() => { mock.restoreAll(); for (const [key, value] of [["CREDENTIALS_ENCRYPTION_KEY", saved.key], ["RUNTIME_BASE_URL", saved.base]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } });
const c: GcpConnection = { id: "00000000-0000-4000-a000-000000000041", user_id: "owner", project_id: "sandbox-project", project_number: "123456789", zone: "us-central1-a", state: "connected", created_at: "", verified_at: null };
test("GCP exchanges a scoped assertion and impersonates only the connection's service account", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return Response.json(url.includes("sts.googleapis.com") ? { access_token: "federated-token" } : { accessToken: "service-account-token", expireTime: new Date(Date.now() + 3600_000).toISOString() });
  });
  assert.equal(await gcpToken(c), "service-account-token"); assert.equal(await gcpToken(c), "service-account-token"); assert.equal(calls.length, 2);
  assert.equal(calls[0].body.audience, gcpNames(c).audience);
  assert.equal(calls[1].url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${gcpNames(c).serviceAccount}:generateAccessToken`);
  const claims = JSON.parse(Buffer.from((calls[0].body.subjectToken as string).split(".")[1], "base64url").toString()); assert.equal(claims.sub, c.id); assert.equal(claims.exp - claims.iat, 300);
  await assert.rejects(gcpToken({ ...c, state: "revoked" }), /disconnected/);
});
test("GCP errors never echo Google's credential-bearing response body", async () => {
  mock.method(globalThis, "fetch", async () => new Response("rejected assertion secret-fragment", { status: 403 }));
  await assert.rejects(googleJson("https://sts.googleapis.com/v1/token", {}, "authentication"), (error: unknown) => error instanceof GcpError && error.status === 403 && !error.message.includes("secret-fragment"));
});
test("a failed Compute operation never becomes a successful sandbox", async () => {
  const api = new GcpApi(c);
  await assert.rejects(api.wait({ name: "operation", status: "DONE", error: { errors: [{ message: "sensitive-upstream-details" }] } }), (error: unknown) => error instanceof Error && /could not finish/.test(error.message) && !error.message.includes("sensitive"));
  await assert.rejects(api.request("/../another-project"), /Invalid/);
});
