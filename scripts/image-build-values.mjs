#!/usr/bin/env node
// The production image's public build values (NEXT_PUBLIC_*), from their one
// home, cloudflare/wrangler.jsonc's image_vars, printed as NAME=value lines
// for $GITHUB_ENV. Fails, naming it, on any that's missing: the Dockerfile
// would refuse the build, or ship a client bundle without it.
//
//   node scripts/image-build-values.mjs [wrangler.jsonc]
//
// No dependencies, so a job can run it before installing any.
import { readFileSync } from "node:fs";

export const IMAGE_BUILD_VALUES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_CODEX_CLI_VERSION", "NEXT_PUBLIC_SENTRY_DSN"];

/** JSON with comments and trailing commas, as wrangler reads it, as JSON:
 *  comments and trailing commas outside strings dropped. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A string, as is, escapes and all.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated /* comment");
      i = end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function imageBuildValues(wranglerText) {
  const vars = parseJsonc(wranglerText).containers?.[0]?.image_vars ?? {};
  const missing = IMAGE_BUILD_VALUES.filter((name) => typeof vars[name] !== "string" || vars[name] === "" || vars[name].includes("\n"));
  if (missing.length) throw new Error(`cloudflare/wrangler.jsonc has no single-line image_vars.${missing.join(", image_vars.")}`);
  return Object.fromEntries(IMAGE_BUILD_VALUES.map((name) => [name, vars[name]]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const values = imageBuildValues(readFileSync(process.argv[2] ?? "cloudflare/wrangler.jsonc", "utf8"));
  for (const [name, value] of Object.entries(values)) console.log(`${name}=${value}`);
}
