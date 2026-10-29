import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  checkDoppler,
  checkInfisical,
  dopplerSecrets,
  infisicalSecrets,
  infisicalSiteUrl,
  linkSecrets,
  SyncError,
} from "@/lib/secret-sync/providers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { url: URL; init: RequestInit };
/** Answer each call with `respond`, and keep what was asked. */
function answer(respond: (url: URL, init: RequestInit) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    const parsed = new URL(url);
    seen.push({ url: parsed, init });
    return Promise.resolve(respond(parsed, init));
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = () => AbortSignal.timeout(5_000);
const SERVICE = "dp.st.dev.0123456789abcdefghij";
const PERSONAL = "dp.pt.0123456789abcdefghij";
const VALUE = "s3cr3t-value-never-shown";

test("a Doppler service token downloads its own config, asked without a project or config", async () => {
  const seen = answer(() => json({ API_KEY: VALUE, PORT: 8080, DOPPLER_PROJECT: "backend", DOPPLER_CONFIG: "dev" }));
  const secrets = await dopplerSecrets({ token: SERVICE }, { project: null, config: null }, signal());
  assert.deepEqual(secrets, { API_KEY: VALUE, PORT: "8080", DOPPLER_PROJECT: "backend", DOPPLER_CONFIG: "dev" });
  assert.equal(seen[0].url.origin + seen[0].url.pathname, "https://api.doppler.com/v3/configs/config/secrets/download");
  assert.equal(seen[0].url.searchParams.get("format"), "json");
  assert.equal(seen[0].url.searchParams.get("project"), null);
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, `Bearer ${SERVICE}`);
  assert.ok(seen[0].init.signal instanceof AbortSignal, "no timeout");
});

test("checking a Doppler service token names its config from the download", async () => {
  answer(() => json({ DOPPLER_PROJECT: "backend", DOPPLER_CONFIG: "stg", X: "1" }));
  assert.deepEqual(await checkDoppler({ token: SERVICE }, "service", { project: null, config: null }, signal()), {
    settings: { tokenKind: "service", project: "backend", config: "stg" },
    label: "backend / stg",
  });
});

test("a personal Doppler token is asked who it is, then must read the project and config it's given", async () => {
  const seen = answer((url) => (url.pathname === "/v3/me" ? json({ workplace: { name: "Acme" } }) : json({ A: "1" })));
  const checked = await checkDoppler({ token: PERSONAL }, "account", { project: "web", config: "prd" }, signal());
  assert.deepEqual(checked, { settings: { tokenKind: "account", project: "web", config: "prd" }, label: "Acme: web / prd" });
  assert.equal(seen[1].url.searchParams.get("project"), "web");
  assert.equal(seen[1].url.searchParams.get("config"), "prd");

  await assert.rejects(
    checkDoppler({ token: PERSONAL }, "account", { project: null, config: null }, signal()),
    (e: SyncError) => e.refused && /needs the project and config/.test(e.message),
  );
});

test("Doppler's refusals say what's wrong; its outages say to wait; neither quotes the body", async () => {
  const cases: Array<[number, RegExp, boolean]> = [
    [401, /revoked/, true],
    [403, /can't read web \/ prd/, true],
    [404, /no config web \/ prd/, true],
    [503, /answered 503/, false],
    [429, /answered 429/, false],
  ];
  for (const [status, message, refused] of cases) {
    answer(() => json({ messages: [`echo ${VALUE}`] }, status));
    await assert.rejects(dopplerSecrets({ token: PERSONAL }, { project: "web", config: "prd" }, signal()), (e: SyncError) => {
      assert.ok(e instanceof SyncError);
      assert.match(e.message, message);
      assert.equal(e.refused, refused);
      assert.ok(!e.message.includes(VALUE) && !e.message.includes(PERSONAL));
      return true;
    });
  }
});

test("a provider that doesn't answer in time, or can't be reached, is an outage", async () => {
  answer(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
  await assert.rejects(dopplerSecrets({ token: SERVICE }, { project: null, config: null }, signal()), (e: SyncError) => !e.refused && /in time/.test(e.message));
  answer(() => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(dopplerSecrets({ token: SERVICE }, { project: null, config: null }, signal()), /Couldn't reach Doppler/);
  answer(() => new Response("<html>bad gateway</html>", { status: 200 }));
  await assert.rejects(dopplerSecrets({ token: SERVICE }, { project: null, config: null }, signal()), /isn't JSON/);
});

test("an Infisical site URL is its cloud by default, else https on a public host", () => {
  assert.equal(infisicalSiteUrl(undefined), "https://app.infisical.com");
  assert.equal(infisicalSiteUrl("  "), "https://app.infisical.com");
  assert.equal(infisicalSiteUrl("https://eu.infisical.com/"), "https://eu.infisical.com");
  assert.equal(infisicalSiteUrl("https://secrets.example.com/infisical/api"), "https://secrets.example.com/infisical");
  for (const refused of ["http://eu.infisical.com", "https://localhost", "https://10.0.0.5", "https://169.254.169.254", "https://u:p@example.com", "https://x.internal", "https://example.com/?a=1", "nope"]) {
    assert.equal(infisicalSiteUrl(refused), null, refused);
  }
});

const SITE = "https://app.infisical.com";
const CREDS = { clientId: "id-1", clientSecret: "secret-1" };

/** Infisical's login and v4 secrets, as its cloud answers them. */
function infisical(secrets: (url: URL) => Response = () => json({ secrets: [{ secretKey: "DB_URL", secretValue: VALUE }], imports: [] })) {
  return answer((url, init) => {
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), CREDS);
      return json({ accessToken: "at-1", expiresIn: 7200, tokenType: "Bearer" });
    }
    return secrets(url);
  });
}

test("Infisical logs in by universal auth, then reads the folder's secrets with the access token", async () => {
  const seen = infisical();
  const got = await linkSecrets(
    { provider: "infisical", credentials: CREDS, settings: { siteUrl: SITE, projectId: "p1", environment: "dev" }, link: { projectId: null, environment: "stg", path: "/api" } },
    signal(),
  );
  assert.deepEqual(got.env, { DB_URL: VALUE });
  const read = seen[1];
  assert.equal(read.url.pathname, "/api/v4/secrets");
  assert.equal(read.url.searchParams.get("projectId"), "p1");
  assert.equal(read.url.searchParams.get("environment"), "stg");
  assert.equal(read.url.searchParams.get("secretPath"), "/api");
  assert.equal(read.url.searchParams.get("expandSecretReferences"), "true");
  assert.equal((read.init.headers as Record<string, string>).authorization, "Bearer at-1");
  // The CLI is signed in with the access token, never the client secret.
  assert.deepEqual(got.cli, {
    INFISICAL_TOKEN: "at-1",
    INFISICAL_API_URL: "https://app.infisical.com/api",
    INFISICAL_PROJECT_ID: "p1",
    INFISICAL_ENVIRONMENT: "stg",
    INFISICAL_SECRET_PATH: "/api",
    INFISICAL_DISABLE_UPDATE_CHECK: "true",
  });
  assert.ok(!JSON.stringify(got.cli).includes(CREDS.clientSecret));
});

test("a folder's own secrets win over its imports, and the first import over a later one", async () => {
  infisical(() =>
    json({
      secrets: [{ secretKey: "A", secretValue: "own" }],
      imports: [
        { secretPath: "/shared", secrets: [{ secretKey: "A", secretValue: "first" }, { secretKey: "B", secretValue: "first" }] },
        { secretPath: "/base", secrets: [{ secretKey: "B", secretValue: "second" }, { secretKey: "C", secretValue: "second" }] },
      ],
    }),
  );
  assert.deepEqual(await infisicalSecrets(SITE, "at-1", { projectId: "p", environment: "dev", path: "/" }, signal()), {
    A: "own",
    B: "first",
    C: "second",
  });
});

test("a self-hosted Infisical without the v4 API is asked v3's raw secrets instead", async () => {
  const seen = infisical((url) =>
    url.pathname === "/api/v4/secrets"
      ? json({ statusCode: 404, message: "Route GET:/api/v4/secrets not found", error: "Not Found" }, 404)
      : json({ secrets: [{ secretKey: "K", secretValue: "v" }] }),
  );
  assert.deepEqual(await infisicalSecrets(SITE, "at-1", { projectId: "p", environment: "dev", path: "/" }, signal()), { K: "v" });
  assert.equal(seen[1].url.pathname, "/api/v3/secrets/raw");
  assert.equal(seen[1].url.searchParams.get("workspaceId"), "p");
});

test("Infisical's refusals: revoked credentials, no access, no such folder", async () => {
  answer(() => json({ message: "Invalid credentials" }, 401));
  await assert.rejects(checkInfisical(SITE, CREDS, { projectId: null, environment: null }, signal()), (e: SyncError) => e.refused && /revoked/.test(e.message));

  infisical(() => json({ message: "no" }, 403));
  await assert.rejects(
    infisicalSecrets(SITE, "at-1", { projectId: "p", environment: "prod", path: "/" }, signal()),
    (e: SyncError) => e.refused && /can't read prod \/ of project p/.test(e.message),
  );
  infisical(() => json({ statusCode: 404, message: "Folder not found" }, 404));
  await assert.rejects(infisicalSecrets(SITE, "at-1", { projectId: "p", environment: "dev", path: "/x" }, signal()), /has no dev \/x/);
  infisical(() => json({}, 502));
  await assert.rejects(infisicalSecrets(SITE, "at-1", { projectId: "p", environment: "dev", path: "/" }, signal()), (e: SyncError) => !e.refused);
});

test("checking an Infisical connection reads its default environment when it names one", async () => {
  const seen = infisical();
  const checked = await checkInfisical("https://eu.infisical.com", CREDS, { projectId: "p1", environment: "dev" }, signal());
  assert.deepEqual(checked, {
    settings: { siteUrl: "https://eu.infisical.com", projectId: "p1", environment: "dev" },
    label: "eu.infisical.com: p1 · dev",
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url.origin, "https://eu.infisical.com");

  const loginOnly = infisical();
  assert.equal((await checkInfisical(SITE, CREDS, { projectId: null, environment: null }, signal())).label, "app.infisical.com");
  assert.equal(loginOnly.length, 1);
});

test("a link with nowhere to read from is refused before any call", async () => {
  const seen = answer(() => json({}));
  await assert.rejects(
    linkSecrets({ provider: "infisical", credentials: CREDS, settings: { siteUrl: SITE, projectId: null, environment: null }, link: { projectId: "p", environment: null, path: null } }, signal()),
    /Pick the Infisical project and environment/,
  );
  await assert.rejects(
    linkSecrets({ provider: "doppler", credentials: { token: PERSONAL }, settings: { tokenKind: "account", project: null, config: null }, link: { project: "web", config: null } }, signal()),
    /Pick the Doppler project and config/,
  );
  assert.equal(seen.length, 0);
});

test("a Doppler service token's link is read without a target, whatever the link says", async () => {
  const seen = answer(() => json({ A: "1" }));
  await linkSecrets(
    { provider: "doppler", credentials: { token: SERVICE }, settings: { tokenKind: "service", project: "backend", config: "dev" }, link: { project: "other", config: "prd" } },
    signal(),
  );
  assert.equal(seen[0].url.searchParams.get("project"), null);
});
