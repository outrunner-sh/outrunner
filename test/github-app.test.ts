import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import {
  appJwt,
  GitHubAppError,
  dropInstallationToken,
  InstallationGoneError,
  InstallationSuspendedError,
  installationPullRequest,
  installationToken,
  installUrl,
  listInstallationRepositories,
  pemFrom,
  readInstallState,
  signInstallState,
  toInstallation,
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

test("an installation as GitHub sends it, or none without an account", () => {
  assert.deepEqual(
    toInstallation({
      id: 7,
      account: { login: "zerotrail", type: "Organization" },
      repository_selection: "selected",
      suspended_at: "2026-10-27T12:00:00Z",
    }),
    { id: 7, accountLogin: "zerotrail", accountType: "Organization", repositorySelection: "selected", suspendedAt: "2026-10-27T12:00:00Z" },
  );
  assert.equal(toInstallation({ id: 7, account: null, repository_selection: "all", suspended_at: null }), null);
  assert.equal(toInstallation({ account: { login: "x", type: "User" } }), null);
});

test("an installation token is made once and kept until 5 minutes before it expires", async () => {
  let made = 0;
  const fake = (async () => {
    made += 1;
    return new Response(JSON.stringify({ token: `t${made}`, expires_at: "2026-10-27T13:00:00Z" }), { status: 201 });
  }) as typeof fetch;
  const config = { clientId: "Iv23test", slug: "s", privateKey: pem, webhookSecret: "w" };
  const at = (iso: string) => new Date(iso).getTime();
  assert.equal(await installationToken(config, 42, fake, at("2026-10-27T12:00:00Z")), "t1");
  assert.equal(await installationToken(config, 42, fake, at("2026-10-27T12:54:00Z")), "t1");
  assert.equal(await installationToken(config, 42, fake, at("2026-10-27T12:56:00Z")), "t2");
  dropInstallationToken(42);
  assert.equal(await installationToken(config, 42, fake, at("2026-10-27T12:56:00Z")), "t3");
});

test("a few of an installation's repositories are one request; all of them, as many pages as there are", async () => {
  const asked: string[] = [];
  const fake = (async (url: string | URL) => {
    const u = new URL(String(url));
    asked.push(`${u.searchParams.get("per_page")}/${u.searchParams.get("page")}`);
    const perPage = Number(u.searchParams.get("per_page"));
    const page = Number(u.searchParams.get("page"));
    const all = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, full_name: `o/r${i + 1}`, private: false }));
    return new Response(
      JSON.stringify({ total_count: 150, repositories: all.slice((page - 1) * perPage, page * perPage) }),
      { status: 200 },
    );
  }) as typeof fetch;
  const few = await listInstallationRepositories("t", { limit: 12 }, fake);
  assert.equal(few.repositories.length, 12);
  assert.equal(few.total, 150);
  assert.deepEqual(asked, ["12/1"]);
  asked.length = 0;
  const all = await listInstallationRepositories("t", {}, fake);
  assert.equal(all.repositories.length, 150);
  assert.deepEqual(asked, ["100/1", "100/2"]);
});

test("a pull request is read with a kept token; one GitHub refuses is minted again once before the installation counts as gone", async () => {
  const config = { clientId: "Iv23test", slug: "s", privateKey: pem, webhookSecret: "w" };
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const run = async (answers: number[], installationId: number) => {
    const calls: string[] = [];
    let minted = 0;
    const fake = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith("/access_tokens")) {
        minted += 1;
        return new Response(JSON.stringify({ token: `t${minted}`, expires_at: later }), { status: 201 });
      }
      const status = answers.shift() ?? 200;
      return new Response(JSON.stringify(status === 200 ? { number: 7, state: "open" } : {}), { status });
    }) as typeof fetch;
    try {
      return { result: await installationPullRequest(config, installationId, "o/r", 7, fake), calls };
    } catch (error) {
      return { error, calls };
    } finally {
      dropInstallationToken(installationId);
    }
  };
  // Refused once (revoked kept token): minted again, read.
  const retried = await run([401, 200], 101);
  assert.deepEqual(retried.result, { number: 7, state: "open" });
  assert.equal(retried.calls.filter((c) => c.endsWith("/access_tokens")).length, 2);
  // Refused again with a fresh one: gone.
  assert.ok((await run([401, 401], 102)).error instanceof InstallationGoneError);
  // A pull request GitHub can't find isn't a gone installation.
  const missing = await run([404], 103);
  assert.ok(missing.error instanceof GitHubAppError && !(missing.error instanceof InstallationGoneError));
  // No token to be had: gone.
  const noToken = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  await assert.rejects(installationPullRequest(config, 104, "o/r", 7, noToken), InstallationGoneError);
  // GitHub won't mint one: suspended, its webhook missed.
  const refused = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  await assert.rejects(installationPullRequest(config, 105, "o/r", 7, refused), InstallationSuspendedError);
});
