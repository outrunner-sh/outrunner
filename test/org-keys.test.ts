import assert from "node:assert/strict";
import { test } from "node:test";

import { fillFromOrg } from "@/lib/orgs/keys";

test("a member's own key always wins; the org's fills in only where they have none", () => {
  const own = new Map<string, string | null>([
    ["anthropic", "mine"],
    ["claude-slot", null],
  ]);
  const filled = fillFromOrg(
    own,
    new Map([
      ["anthropic", "org's"],
      ["openai", "org's openai"],
    ]),
  );
  assert.equal(own.get("anthropic"), "mine");
  assert.equal(own.get("openai"), "org's openai");
  assert.deepEqual([...filled], ["openai"]);
  // A slot the member left empty isn't the org's to fill: it isn't a provider.
  assert.equal(own.get("claude-slot"), null);
});
