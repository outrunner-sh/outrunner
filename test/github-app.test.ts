import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import {
  appJwt,
  installUrl,
  pemFrom,
  readInstallState,
  signInstallState,
  userCanReachInstallation,
  webhookSignatureMatches,
} from "@/lib/github/app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("the App's JWT is RS256, signed with its key, issued by its Client ID for 9 minutes from a minute back", () => {
  const jwt = appJwt("Iv23test", pem, 1_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    iat: 999_940,
    exp: 1_000_540,
    iss: "Iv23test",
  });
  const valid = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url");
  assert.equal(valid, true);
});

test("the private key reads as the .pem, base64'd, or with its newlines escaped", () => {
  assert.equal(pemFrom(pem), pem.trim() + "\n");
  assert.equal(pemFrom(Buffer.from(pem).toString("base64")), pem.trim() + "\n");
  assert.equal(pemFrom(pem.replace(/\n/g, "\\n")), pem.trim() + "\n");
});

test("a webhook is GitHub's only with the signature of its raw body under the secret", () => {
  const body = '{"action":"deleted"}';
  const signature = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(webhookSignatureMatches("s3cret", body, signature), true);
  assert.equal(webhookSignatureMatches("s3cret", body + " ", signature), false);
  assert.equal(webhookSignatureMatches("other", body, signature), false);
  assert.equal(webhookSignatureMatches("s3cret", body, null), false);
  assert.equal(webhookSignatureMatches("s3cret", body, "sha1=abc"), false);
});

test("an install link's state names the org and admin, and only while it's ours, unchanged and fresh", () => {
  const state = signInstallState("s3cret", { orgId: "org-1", userId: "user-1" }, 1_000);
  assert.deepEqual(readInstallState("s3cret", state, 1_000 + 60), { orgId: "org-1", userId: "user-1" });
  // Expired after 30 minutes.
  assert.equal(readInstallState("s3cret", state, 1_000 + 30 * 60 + 1), null);
  // Another secret, or a payload changed.
  assert.equal(readInstallState("other", state, 1_060), null);
  const [, mac] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ o: "org-2", u: "user-1", e: 99_999 })).toString("base64url");
  assert.equal(readInstallState("s3cret", `${forged}.${mac}`, 1_060), null);
  assert.equal(readInstallState("s3cret", null), null);
  assert.equal(readInstallState("s3cret", "nonsense"), null);
  // Not a webhook signature: the same secret, kept apart.
  assert.notEqual(state.split(".")[1], createHmac("sha256", "s3cret").update(state.split(".")[0]).digest("base64url"));
});

test("the install link is the App's new-installation page with the state", () => {
  assert.equal(
    installUrl("outrunner-sh", "a.b"),
    "https://github.com/apps/outrunner-sh/installations/new?state=a.b",
  );
});

test("a user reaches an installation when GitHub lists it among theirs, across pages", async () => {
  const pages: Record<number, Array<{ id: number }>> = {
    1: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
    2: [{ id: 555 }],
  };
  const fake = (async (url: string | URL) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    const installations = (pages[page] ?? []).map((i) => ({ ...i, account: null, repository_selection: "all", suspended_at: null }));
    return new Response(JSON.stringify({ installations }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await userCanReachInstallation("t", 555, fake), true);
  assert.equal(await userCanReachInstallation("t", 777, fake), false);
});
