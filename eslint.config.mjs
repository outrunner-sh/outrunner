import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Work after the response goes through lib/observability/after.ts: its
    // errors are reported, and a shutdown waits for it (server.ts).
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["lib/observability/after.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/server",
              importNames: ["after"],
              message: "Use `after` from @/lib/observability/after: it reports errors and holds a shutdown until the work ends.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    // Includes output from the isolated browser fixture app.
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
