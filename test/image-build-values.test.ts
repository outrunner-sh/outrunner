import assert from "node:assert/strict";
import { test } from "node:test";

import { imageBuildValues, parseJsonc } from "../scripts/image-build-values.mjs";

// wrangler.jsonc is the one home of the image's public build values; the
// image job reads it without dependencies, so it parses JSONC by hand.
test("JSONC: comments and trailing commas go, strings stay as they are", () => {
  const text = `{
    // a comment, then a URL whose // is no comment
    "url": "https://auth.example.com/a//b", /* block */
    "s": "quote \\" and // inside",
    "list": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { url: "https://auth.example.com/a//b", s: 'quote " and // inside', list: [1, 2] });
});

test("the image's public values, or which are missing", () => {
  const wrangler = (vars: object) => JSON.stringify({ containers: [{ image_vars: vars }] });
  const all = { NEXT_PUBLIC_SUPABASE_URL: "https://auth.example.com", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x", NEXT_PUBLIC_CODEX_CLI_VERSION: "0.1.4" };
  assert.deepEqual(imageBuildValues(wrangler({ ...all, OTHER: "x" })), all);
  assert.throws(() => imageBuildValues(wrangler({ ...all, NEXT_PUBLIC_SUPABASE_ANON_KEY: "" })), /image_vars\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});
