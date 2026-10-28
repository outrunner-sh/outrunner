import assert from "node:assert/strict";
import { test } from "node:test";

import { newBoxSize, withOrgDefault } from "@/lib/orgs/defaults";

test("a member's chosen box size wins; the org's is for one who never chose", () => {
  assert.equal(newBoxSize({ boxSize: "small", boxSizeChosen: false }, "medium"), "medium");
  assert.equal(newBoxSize({ boxSize: "small", boxSizeChosen: true }, "medium"), "small");
  assert.equal(newBoxSize({ boxSize: "small", boxSizeChosen: false }, null), "small");
});

test("a member's default model wins; the org's is for one who set none, shown with their models", () => {
  const glm = { provider: "outrunner" as const, id: "z-ai/glm-5.3" };
  const kimi = { provider: "outrunner" as const, id: "moonshotai/kimi-k3" };
  assert.deepEqual(withOrgDefault({ models: [glm], default: glm }, kimi), { models: [glm], default: glm });
  assert.deepEqual(withOrgDefault({ models: [glm], default: null }, kimi), { models: [glm, kimi], default: kimi });
  // One they keep already, at their effort.
  const theirs = { ...kimi, effort: "low" as const };
  assert.deepEqual(withOrgDefault({ models: [theirs], default: null }, kimi), { models: [theirs], default: theirs });
  assert.deepEqual(withOrgDefault({ models: [], default: null }, null), { models: [], default: null });
});
