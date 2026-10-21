import assert from "node:assert/strict";
import { test } from "node:test";

import { requireFeature } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";

/** A box whose agent has `features`, upgraded to `upgraded` where it can be. */
function box(features: string[], upgraded?: string[]) {
  let current = features;
  let upgrades = 0;
  return {
    client: {
      features: async () => current,
      ...(upgraded && {
        upgrade: async () => {
          upgrades++;
          current = upgraded;
        },
      }),
    },
    upgrades: () => upgrades,
  };
}

test("an agent with the feature is used as it is", async () => {
  const b = box(["restore-imports"], ["restore-imports"]);
  await requireFeature(b.client, "restore-imports", "restore an import");
  assert.equal(b.upgrades(), 0);
});

test("an older agent is upgraded in place first", async () => {
  const b = box([], ["restore-imports"]);
  await requireFeature(b.client, "restore-imports", "restore an import");
  assert.equal(b.upgrades(), 1);
});

test("an agent that can't be upgraded to it says what the box can't do", async () => {
  for (const b of [box([]), box([], [])]) {
    await assert.rejects(
      requireFeature(b.client, "restore-imports", "restore an import"),
      (error: unknown) =>
        error instanceof OutdatedComputerError && error.message === "This project's cloud computer can't restore an import.",
    );
  }
});
