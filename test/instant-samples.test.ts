import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * The build stops when an instant page doesn't name, in its
 * `unstable_instant` samples, a cookie its render reads:
 *
 *   Route "/" accessed cookie "outrunner_org" which is not defined in the
 *   `samples` of `unstable_instant`. Add it to the sample's `cookies` array…
 *
 * What decides those names is the app layout's chrome (app/(app)/layout.tsx:
 * `ChromeData` reads cookies and nothing else, and the list it holds waits on
 * the owner, who isn't there during the build's own render). The names are
 * repeated in each page rather than imported, because a segment config is read
 * by static analysis, which cannot follow a constant — so a cookie added to
 * the chrome is a one-line change that only the build would catch. This is
 * that check, quick enough to run with the rest (lib/nav/sidebar.ts).
 *
 * A segment config is a literal in the page's own source, so it is read with
 * the TypeScript parser rather than by matching text.
 */

const LAYOUT = path.join(process.cwd(), "app", "(app)", "layout.tsx");
const APP = path.join(process.cwd(), "app", "(app)");

test("every instant page under the app layout names the cookies its chrome reads", () => {
  const chrome = [...chromeCookies()].sort();
  assert.ok(chrome.length > 0, "the layout's chrome reads no cookies to check against");
  const pages = instantPages();
  assert.ok(pages.length > 0, "no instant pages found under app/(app)");

  for (const page of pages) {
    const where = path.relative(process.cwd(), page);
    const config = objectOf(sourceOf(page), "unstable_instant");
    const samples = config && property(config, "samples");
    assert.ok(samples && ts.isArrayLiteralExpression(samples), `${where}: unstable_instant declares no samples`);
    assert.ok(samples.elements.length > 0, `${where}: unstable_instant declares an empty samples`);
    samples.elements.forEach((sample, i) => {
      assert.ok(ts.isObjectLiteralExpression(sample), `${where}: sample ${i + 1} isn't an object`);
      const named = cookieNames(sample);
      assert.deepEqual(
        chrome.filter((cookie) => !named.has(cookie)),
        [],
        `${where}: sample ${i + 1} names every cookie the layout's chrome reads`,
      );
    });
  }
});

/** The pages under the app layout that declare themselves instant. */
function instantPages(dir: string = APP): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) pages.push(...instantPages(full));
    else if (entry.name === "page.tsx" && readFileSync(full, "utf8").includes("unstable_instant")) pages.push(full);
  }
  return pages;
}

/**
 * The cookies the layout's chrome reads: each `jar.get(X)` in it, X a string
 * constant exported by the module the layout imports it from (`jar` is read
 * only there).
 */
function chromeCookies(): Set<string> {
  const source = sourceOf(LAYOUT);
  const importedFrom = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!from.startsWith("@/")) continue;
    for (const binding of bindings.elements) importedFrom.set(binding.name.text, from);
  }

  const cookies = new Set<string>();
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const call = node.expression;
    if (!ts.isPropertyAccessExpression(call) || call.name.text !== "get") return;
    const [argument] = node.arguments;
    if (!argument || !ts.isIdentifier(argument) || !importedFrom.has(argument.text)) return;
    const from = importedFrom.get(argument.text)!;
    const value = exportedString(moduleOf(from), argument.text);
    assert.ok(value, `${from} exports no string ${argument.text}`);
    cookies.add(value);
  });
  return cookies;
}

/** The cookie names one sample declares. */
function cookieNames(sample: ts.ObjectLiteralExpression): Set<string> {
  const names = new Set<string>();
  const cookies = property(sample, "cookies");
  if (!cookies || !ts.isArrayLiteralExpression(cookies)) return names;
  for (const element of cookies.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const name = property(element, "name");
    if (name && ts.isStringLiteral(name)) names.add(name.text);
  }
  return names;
}

/** The module an `@/…` import names, whichever extension it has. */
function moduleOf(from: string): ts.SourceFile {
  const stem = path.join(process.cwd(), from.slice(2));
  for (const extension of [".ts", ".tsx"]) {
    try {
      return sourceOf(`${stem}${extension}`);
    } catch {
      // The other extension, then.
    }
  }
  throw new Error(`no module at ${from}`);
}

function sourceOf(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The initialiser of a `const name = …` at the top level, as an object. */
function objectOf(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  walk(source, (node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) found = declaration.initializer;
    }
  });
  return found;
}

/** The value a module's own `export const name = "…"` holds. */
function exportedString(source: ts.SourceFile, name: string): string | null {
  let value: string | null = null;
  walk(source, (node) => {
    if (!ts.isVariableStatement(node)) return;
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (declaration.initializer && ts.isStringLiteral(declaration.initializer)) value = declaration.initializer.text;
    }
  });
  return value;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === name) return member.initializer;
  }
  return null;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
