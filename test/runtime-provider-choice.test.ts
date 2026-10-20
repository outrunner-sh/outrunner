import assert from "node:assert/strict";
import { test } from "node:test";

import { providerName } from "@/lib/env";
import { resetRuntimeProvider } from "@/lib/runtime/provider";
import { providerNamed } from "@/lib/runtime/sandbox-choice";

/** Set RUNTIME_PROVIDER for one check, then put the environment back. */
function withProvider(value: string | undefined, check: () => void): void {
  const before = process.env.RUNTIME_PROVIDER;
  if (value === undefined) delete process.env.RUNTIME_PROVIDER;
  else process.env.RUNTIME_PROVIDER = value;
  try {
    check();
  } finally {
    if (before === undefined) delete process.env.RUNTIME_PROVIDER;
    else process.env.RUNTIME_PROVIDER = before;
  }
}

test("the legacy modal provider cannot be selected: its boxes ran unmetered", () => {
  // Modal was the workspace-per-sandbox backend. Nothing ever opened a compute
  // interval for its boxes and the reconciler skipped the provider entirely, so
  // on a modal deployment every box ran unmetered, forever, and the plan's
  // cloud-hour gate read an empty table. It must refuse to boot, not run.
  withProvider("modal", () => {
    assert.throws(() => providerName(), /Invalid RUNTIME_PROVIDER/);
  });
});

test("local, daytona and neev remain selectable", () => {
  for (const name of ["local", "daytona", "neev"]) {
    withProvider(name, () => assert.equal(providerName(), name));
  }
});

test("an unset RUNTIME_PROVIDER stays local, for development", () => {
  withProvider(undefined, () => assert.equal(providerName(), "local"));
});

test("an unknown RUNTIME_PROVIDER is refused", () => {
  withProvider("some-other-cloud", () => {
    assert.throws(() => providerName(), /Invalid RUNTIME_PROVIDER/);
  });
});

test("a workspace the removed modal provider made resolves to no provider, so only its deletion remains", () => {
  // Rows from a deployment that ran modal still name it. They must resolve to
  // null (resolveProvider's 409, which the lifecycle route answers with
  // destroy-only), not to a provider that could run boxes unmetered again.
  const before = process.env.RUNTIME_PROVIDER;
  process.env.RUNTIME_PROVIDER = "daytona";
  try {
    resetRuntimeProvider();
    assert.equal(providerNamed("modal", { daytona: async () => null, modal: async () => null }), null);
  } finally {
    if (before === undefined) delete process.env.RUNTIME_PROVIDER;
    else process.env.RUNTIME_PROVIDER = before;
    resetRuntimeProvider();
  }
});
