import assert from "node:assert/strict";
import { test } from "node:test";

import { modelKeyErrorResponse } from "@/lib/http/model-key-errors";
import { AllowanceSpentError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { StoredKeyUnreadableError } from "@/lib/openrouter/user-key";
import { NoProviderKeyError } from "@/lib/providers/errors";

async function answered(error: unknown) {
  const response = modelKeyErrorResponse(error, "context");
  return { status: response.status, body: (await response.json()) as { error: string; settingsHref?: string } };
}

test("each failure to get a model's key answers what the user can do about it", async () => {
  assert.equal((await answered(new OutrunnerModelsUnavailableError())).status, 503);
  assert.equal((await answered(new StoredKeyUnreadableError())).status, 503);

  const missing = await answered(new NoProviderKeyError("zai"));
  assert.deepEqual(missing, {
    status: 409,
    body: { error: "Save your Z.ai key in Settings → Providers to run models on it.", settingsHref: "/settings/providers?tab=zai" },
  });

  const spent = await answered(new AllowanceSpentError());
  assert.equal(spent.status, 409);
  assert.equal(spent.body.error, new AllowanceSpentError().message);
});

test("anything else is a 502 that keeps its message in the log", async () => {
  const error = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(...args);
  try {
    const { status, body } = await answered(new Error("OpenRouter: 500 internal sk-or-v1-secret"));
    assert.equal(status, 502);
    assert.doesNotMatch(body.error, /sk-or|500/);
    assert.equal(logged[0], "context");
  } finally {
    console.error = error;
  }
});
