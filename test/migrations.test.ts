import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

test("every migration has its own version, as the database records only one per version", () => {
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
  const seen = new Map<string, string>();
  for (const file of files) {
    const version = file.split("_")[0];
    assert.match(version, /^\d{14}$/, file);
    assert.equal(seen.get(version), undefined, `${file} has ${seen.get(version)}'s version`);
    seen.set(version, file);
  }
});
