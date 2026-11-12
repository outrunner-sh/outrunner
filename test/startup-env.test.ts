import assert from "node:assert/strict";
import { test } from "node:test";

import { DEPLOYMENT_PROVIDERS } from "@/lib/env";
import { startupEnvProblems } from "@/lib/startup-env";

const COMPLETE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  CREDENTIALS_ENCRYPTION_KEY: "key",
  RUNTIME_PROVIDER: "daytona",
  DAYTONA_API_KEY: "dtn",
};

test("a complete environment has no problems; optional settings stay optional", () => {
  assert.deepEqual(startupEnvProblems(COMPLETE), []);
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, RUNTIME_PROVIDER: undefined, DAYTONA_API_KEY: undefined }), []);
});

test("every missing setting is named at once, blank counting as missing", () => {
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, SUPABASE_SERVICE_ROLE_KEY: "  ", CREDENTIALS_ENCRYPTION_KEY: undefined }), [
    "SUPABASE_SERVICE_ROLE_KEY is not set",
    "CREDENTIALS_ENCRYPTION_KEY is not set",
  ]);
});

test("the provider's own settings are required with it, and only with it", () => {
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, DAYTONA_API_KEY: "" }), ["DAYTONA_API_KEY is not set"]);
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, RUNTIME_PROVIDER: "neev", NEEV_API_KEY: "k" }), [
    "NEEV_ORG_ID is not set",
    "NEEV_PROJECT_ID is not set",
  ]);
  assert.equal(startupEnvProblems({ ...COMPLETE, RUNTIME_PROVIDER: "kubernetes" }).length, 1);
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, RUNTIME_PROVIDER: "e2b", OUTRUNNER_E2B_API_KEY: "e2b_k" }), [
    "OUTRUNNER_E2B_API_URL is not set",
    "OUTRUNNER_E2B_SANDBOX_URL is not set",
  ]);
});

test("the E2B SDK's own fallbacks are refused at boot, whatever the provider", () => {
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, E2B_API_URL: "https://e2b.example", E2B_DOMAIN: "e2b.example" }), [
    "E2B_API_URL is set, which the E2B SDK would use for every E2B: rename it to OUTRUNNER_E2B_API_URL",
    "E2B_DOMAIN is set, which the E2B SDK would use for every E2B: unset it",
  ]);
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, E2B_SANDBOX_URL: " " }), [], "blank is unset");
});

test("every provider the app runs on is one a deployment may start with", () => {
  for (const provider of DEPLOYMENT_PROVIDERS) {
    const problems = startupEnvProblems({ ...COMPLETE, RUNTIME_PROVIDER: provider });
    assert.ok(!problems.some((problem) => problem.startsWith("RUNTIME_PROVIDER")), `${provider}: ${problems.join("; ")}`);
  }
});

test("a malformed URL is named, an optional one only when set", () => {
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, NEXT_PUBLIC_SUPABASE_URL: "abc" }), ["NEXT_PUBLIC_SUPABASE_URL is not a URL"]);
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, SENTRY_DSN: "nope" }), ["SENTRY_DSN is not a URL"]);
  assert.deepEqual(startupEnvProblems({ ...COMPLETE, SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" }), []);
});
