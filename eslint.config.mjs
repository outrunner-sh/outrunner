import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The embedded native desktop shell is its own project (its own repo).
    "runtime-desktop/**",
    // wrangler writes a bundled worker here on every deploy. Linting a build
    // artifact produced six warnings that read like real findings.
    "cloudflare/.wrangler/**",
    // Build output: the staged npm packages (scripts/build-cli.sh), and the like.
    ".context/**",
  ]),
]);

export default eslintConfig;
