import assert from "node:assert/strict";
import { test } from "node:test";

import { importFoundText } from "@/lib/onboarding/import-offer";

test("what was found reads as a count and where, joined as a sentence", () => {
  assert.equal(importFoundText({ sessions: 1, sources: ["conductor"] }), "Found 1 session in Conductor.");
  assert.equal(
    importFoundText({ sessions: 14, sources: ["conductor", "claude-cli"] }),
    "Found 14 sessions in Conductor and Claude Code.",
  );
  assert.equal(
    importFoundText({ sessions: 5, sources: ["conductor", "claude-cli", "codex-cli"] }),
    "Found 5 sessions in Conductor, Claude Code and Codex.",
  );
});
