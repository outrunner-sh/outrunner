import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getRuntimeProvider, platformComputerProviders, platformProvider, resetRuntimeProvider } from "@/lib/runtime/provider";

const KEYS = ["RUNTIME_PROVIDER", "DAYTONA_API_KEY", "NEEV_API_KEY", "NEEV_ORG_ID", "NEEV_PROJECT_ID", "OUTRUNNER_E2B_API_KEY", "OUTRUNNER_E2B_API_URL", "OUTRUNNER_E2B_SANDBOX_URL"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function withEnv(env: Record<string, string>): void {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  resetRuntimeProvider();
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetRuntimeProvider();
});

test("a box is reached with the backend that made it, not the deployment's", () => {
  withEnv({ RUNTIME_PROVIDER: "e2b", DAYTONA_API_KEY: "dtn_test" });
  assert.equal(platformProvider("e2b"), getRuntimeProvider());
  assert.equal(platformProvider("daytona")?.name, "daytona");
  assert.equal(platformProvider("daytona"), platformProvider("daytona"), "made once");
  // No Neev credentials: its boxes can't be reached, never taken for E2B's.
  assert.equal(platformProvider("neev"), null);
  // A user's own sandbox is never one of Outrunner's.
  assert.equal(platformProvider("user-daytona"), null);
  assert.deepEqual(platformComputerProviders().map((provider) => provider.name), ["e2b", "daytona"]);
});

test("a deployment that moved from E2B still reaches E2B's boxes while its keys are set", () => {
  withEnv({ RUNTIME_PROVIDER: "daytona", DAYTONA_API_KEY: "dtn_test", OUTRUNNER_E2B_API_KEY: "e2b_test", OUTRUNNER_E2B_API_URL: "https://api.e2b.test", OUTRUNNER_E2B_SANDBOX_URL: "https://sandbox.e2b.test" });
  assert.equal(platformProvider("e2b")?.name, "e2b");
  withEnv({ RUNTIME_PROVIDER: "daytona", DAYTONA_API_KEY: "dtn_test", OUTRUNNER_E2B_API_KEY: "e2b_test" });
  assert.equal(platformProvider("e2b"), null, "not without both URLs");
});
