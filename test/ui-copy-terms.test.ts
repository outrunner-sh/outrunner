/**
 * The app says Environments and repositories, not "projects" (renamed
 * 2026-11, after Replicas' model): this fails when UI copy in components/ or
 * app/ says "project" again. Code names (props, ids, `?project=`) aren't copy
 * and aren't looked at. Other products' projects (Doppler, Infisical, Jira,
 * Google Cloud, OpenAI, Linear) keep their own word: those are allowed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOTS = ["components", "app"];

/** Copy that is about another product's projects, by what it mentions. */
const OTHER_PRODUCTS = /doppler|infisical|jira|google cloud|gcp|openai|linear|gitlab/i;

/** Files whose copy is all about another product's projects. */
const OTHER_PRODUCT_FILES = new Set([
  "components/tracker-settings.tsx",
  "components/secret-sync-connect.tsx",
  "components/secret-sync-panel.tsx",
  "components/sandbox-settings.tsx",
]);

const WORD = /\bprojects?\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : files(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** The copy on a line: prose string literals (they have a space), and JSX
 *  text (a line of words alone, or words between a tag's `>` and `<`). */
function copyOn(line: string): string[] {
  const trimmed = line.trim();
  if (/^(\/\/|\*|\/\*|import )/.test(trimmed)) return [];
  const found: string[] = [];
  for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    // A template's interpolations are code: `${row.project}` names a field.
    const text = match[2].replace(/\$\{[^}]*\}/g, "");
    // Prose has a space; a label is one capitalized word ("Projects"), where a
    // lowercase one is a key (`option("projects", …)`).
    if ((/\s/.test(text.trim()) && /[a-z]/i.test(text)) || /^[A-Z][a-z]+$/.test(text)) found.push(text);
  }
  // A line of words alone, not a prop or key (`projects,`, `project: p,`).
  if (/^[A-Za-z][^=;{}()<>"'`]*$/.test(trimmed) && !/[,:]$/.test(trimmed) && !/^\w+:\s/.test(trimmed)) found.push(trimmed);
  for (const match of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) found.push(match[1]);
  return found;
}

test("UI copy says environment or repository, never project", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of files(root)) {
      if (OTHER_PRODUCT_FILES.has(file)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const copy of copyOn(line)) {
          if (WORD.test(copy) && !OTHER_PRODUCTS.test(copy) && !OTHER_PRODUCTS.test(line)) {
            offenders.push(`${file}:${index + 1}: ${copy.trim()}`);
          }
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `Say "environment" or "repository" instead:\n${offenders.join("\n")}`);
});

test("the guard sees copy, and only copy", () => {
  assert.ok(copyOn(`  label="Projects"`).some((c) => WORD.test(c)));
  assert.deepEqual(copyOn(`  {option("projects", "Repositories")}`).filter((c) => WORD.test(c)), []);
  assert.ok(copyOn(`  <h1 className="x">Projects</h1>`).some((c) => WORD.test(c)));
  assert.ok(copyOn(`        You can see this project and start sessions`).some((c) => WORD.test(c)));
  assert.ok(copyOn(`  detail="Loaded in every new session of the project."`).some((c) => WORD.test(c)));
  // Code isn't copy.
  assert.deepEqual(copyOn(`  const project = search.get("project") ?? undefined;`).filter((c) => WORD.test(c)), []);
  assert.deepEqual(copyOn(`  projects={projects}`).filter((c) => WORD.test(c)), []);
  assert.deepEqual(copyOn(`  projects,`).filter((c) => WORD.test(c)), []);
  assert.deepEqual(copyOn(`  project: s.name,`).filter((c) => WORD.test(c)), []);
  assert.deepEqual(copyOn("  const parts = [`${row.project} · this Mac`];").filter((c) => WORD.test(c)), []);
  assert.ok(copyOn(`              Project`).some((c) => WORD.test(c)));
});
