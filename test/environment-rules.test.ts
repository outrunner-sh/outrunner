import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applySecretsEdit,
  checkoutNameFor,
  EnvironmentRuleError,
  instructionsText,
  MAX_FILES,
  optionalText,
  parseDotenv,
  projectName,
  script,
  utf8Bytes,
  validFilePath,
} from "@/lib/environments/rules";

test("an edit sets, replaces and removes variables and files", () => {
  const next = applySecretsEdit(
    { env: { A: "1", B: "2" }, files: { ".env": "X=1\n", "api/.env": "Y=2\n" } },
    { setEnv: { B: "3", C: "4" }, removeEnv: ["A"], setFiles: { "web/.env.local": "Z=3\n" }, removeFiles: [".env"] },
  );
  assert.deepEqual(next, { env: { B: "3", C: "4" }, files: { "api/.env": "Y=2\n", "web/.env.local": "Z=3\n" } });
});

test("a variable a session sets itself, or a path outside the checkout, is refused", () => {
  const empty = { env: {}, files: {} };
  for (const name of ["PATH", "ANTHROPIC_API_KEY", "RUNTIME_AGENT_SECRET", "1BAD", "has-dash"]) {
    assert.throws(() => applySecretsEdit(empty, { setEnv: { [name]: "x" } }), EnvironmentRuleError, name);
  }
  for (const path of ["/etc/passwd", "../up", "a/../../b", "a//b", "./a", "", "a\\b"]) {
    assert.equal(validFilePath(path), false, path);
    assert.throws(() => applySecretsEdit(empty, { setFiles: { [path]: "x" } }), EnvironmentRuleError, path);
  }
  assert.equal(validFilePath("apps/api/.env"), true);
});

test("more than a session takes is refused", () => {
  const files = Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`f${i}`, "x"]));
  assert.throws(() => applySecretsEdit({ env: {}, files: {} }, { setFiles: files }), EnvironmentRuleError);
  assert.throws(() => applySecretsEdit({ env: {}, files: {} }, { setEnv: { BIG: "x".repeat(300 * 1024) } }), EnvironmentRuleError);
});

test("a pasted .env reads as its variables, the lines that aren't one apart", () => {
  const { env, skipped } = parseDotenv(
    [
      "# comment",
      "",
      "export API_TOKEN=abc123",
      'DATABASE_URL="postgres://u:p@db/app"',
      "SINGLE='it''s'",
      'ESCAPED="line1\\nline2 \\"q\\""',
      "PLAIN=value # trailing comment",
      "EMPTY=",
      "not a variable",
    ].join("\n"),
  );
  assert.deepEqual(env, {
    API_TOKEN: "abc123",
    DATABASE_URL: "postgres://u:p@db/app",
    SINGLE: "it''s",
    ESCAPED: 'line1\nline2 "q"',
    PLAIN: "value",
    EMPTY: "",
  });
  assert.deepEqual(skipped, ["not a variable"]);
});

test("a repository's folder is its name, made safe", () => {
  assert.equal(checkoutNameFor("outrunner"), "outrunner");
  assert.equal(checkoutNameFor("my repo!"), "my-repo-");
  assert.equal(checkoutNameFor(".."), "repo");
});

test("names, text and scripts are trimmed or refused", () => {
  assert.equal(projectName("  Neevcloud "), "Neevcloud");
  assert.throws(() => projectName("   "), EnvironmentRuleError);
  assert.equal(optionalText("  ", 10, "x"), null);
  assert.throws(() => optionalText("x".repeat(11), 10, "x"), EnvironmentRuleError);
  assert.equal(script("  \n", "setup script"), null);
  assert.equal(script("#!/bin/bash\npnpm install\n", "setup script"), "#!/bin/bash\npnpm install\n");
});

test("limits are measured in UTF-8 bytes, as the agent measures them", () => {
  // Three bytes a character: under the limit in characters, over it in bytes.
  const wide = "界".repeat(Math.floor((16 * 1024) / 3) + 1);
  assert.throws(() => instructionsText(wide), EnvironmentRuleError);
  assert.equal(instructionsText("  Use pnpm.  "), "Use pnpm.");
  assert.equal(instructionsText(" "), null);
  assert.equal(utf8Bytes("é界"), 5);
  assert.throws(() => script("界".repeat(Math.floor((64 * 1024) / 3) + 1), "setup script"), EnvironmentRuleError);
  const files = { big: "界".repeat(Math.floor((1024 * 1024) / 3) + 1) };
  assert.throws(() => applySecretsEdit({ env: {}, files: {} }, { setFiles: files }), EnvironmentRuleError);
});
