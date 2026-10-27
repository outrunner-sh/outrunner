import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFileTree, codeLanguage, type FileTreeDir, searchFiles } from "@/lib/session/file-tree";

/** The tree as indented lines, folders marked with a slash. */
function outline(dir: FileTreeDir, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return [
    ...dir.dirs.flatMap((child) => [`${pad}${child.name}/ (${child.path})`, ...outline(child, depth + 1)]),
    ...dir.files.map((file) => `${pad}${file.name}`),
  ];
}

test("buildFileTree puts folders first and folds a chain of lone folders", () => {
  const tree = buildFileTree([
    "README.md",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "app/page.tsx",
    "app/api/route.ts",
    "a.ts",
    "deep/one/two/x.ts",
    "deep/y.ts",
  ]);
  assert.deepEqual(outline(tree), [
    ".github / workflows/ (.github/workflows)",
    "  ci.yml",
    "  release.yml",
    "app/ (app)",
    "  api/ (app/api)",
    "    route.ts",
    "  page.tsx",
    "deep/ (deep)",
    "  one / two/ (deep/one/two)",
    "    x.ts",
    "  y.ts",
    "a.ts",
    "README.md",
  ]);
});

test("searchFiles wants every word, file names first, then shorter paths", () => {
  const paths = ["components/workspace-files.tsx", "hooks/use-workspace-files.ts", "lib/files/workspace.ts", "README.md"];
  assert.deepEqual(searchFiles(paths, "workspace-files", 10), [
    "hooks/use-workspace-files.ts",
    "components/workspace-files.tsx",
  ]);
  assert.deepEqual(searchFiles(paths, "FILES workspace", 10), [
    "lib/files/workspace.ts",
    "hooks/use-workspace-files.ts",
    "components/workspace-files.tsx",
  ]);
  assert.deepEqual(searchFiles(paths, "files", 1), ["hooks/use-workspace-files.ts"]);
  assert.deepEqual(searchFiles(paths, "   ", 10), []);
});

test("codeLanguage goes by extension, or by a name that has none", () => {
  assert.equal(codeLanguage("app/page.tsx"), "typescript");
  assert.equal(codeLanguage("box/Dockerfile"), "bash");
  assert.equal(codeLanguage("Makefile"), "makefile");
  assert.equal(codeLanguage("wrangler.jsonc"), "json");
  assert.equal(codeLanguage(".gitignore"), null);
  assert.equal(codeLanguage("LICENSE"), null);
});
