/**
 * What kind of lines a pull request changes: code, tests, or generated files
 * (lockfiles, snapshots, generated paths, vendored code). A 2,000-line PR that
 * is 1,900 lines of lockfile is a small review, and the Review tab says so.
 * Read from the path alone, so it's the same everywhere a PR's size shows.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

export type LineKind = "code" | "test" | "generated";

/** Lines added and removed. */
export type LineDelta = { additions: number; deletions: number };

/** A PR's lines, by kind. */
export type LineCounts = Record<LineKind, LineDelta>;

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "go.work.sum",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "package.resolved",
  "packages.lock.json",
  "flake.lock",
  "gradle.lockfile",
  ".terraform.lock.hcl",
]);

// Folders whose files someone else wrote: vendored dependencies and build
// output that got committed.
const VENDORED_DIRS = new Set(["vendor", "vendors", "node_modules", "third_party", "third-party", "thirdparty", "godeps", "bower_components", "dist"]);

// Folders whose files a tool wrote.
const GENERATED_DIRS = new Set(["generated", "__generated__", "__snapshots__", "snapshots", "gen-src"]);

const GENERATED_FILES = [
  /\.snap$/,
  /\.snap\.[a-z]+$/,
  /\.(generated|gen)\.[a-z0-9]+$/,
  /_generated\.[a-z0-9]+$/,
  /\.pb(\.[a-z]+)?\.go$/,
  /\.pb\.(ts|js|cc|h|swift|dart)$/,
  /_pb2(_grpc)?\.pyi?$/,
  /_grpc_pb\.(js|d\.ts)$/,
  /\.min\.(js|css|mjs)$/,
  /\.(js|css)\.map$/,
  /\.lock$/,
];

const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "specs", "e2e", "testdata", "test-data", "fixtures", "__fixtures__", "testing"]);

const TEST_FILES = [
  /\.(test|spec|e2e)\.[a-z0-9]+$/,
  /\.fixtures?\.[a-z0-9]+$/,
  /_test\.(go|py|rb|exs?|dart|cc|cpp|c|rs)$/,
  /_spec\.rb$/,
  /^test_[^/]+\.py$/,
  /^conftest\.py$/,
];

// A Java or Kotlin test class is named for what it tests (`FooTest.java`):
// read on the name as written, so `Latest.java` isn't one.
const TEST_CLASS = /[a-z0-9](Test|Tests|Spec|IT)\.(java|kt|kts|scala|cs|swift|m)$/;

/** What a changed file's lines are, by its path in the repository. */
export function lineKind(path: string): LineKind {
  const parts = path.toLowerCase().split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  const dirs = parts.slice(0, -1);
  if (LOCKFILES.has(name)) return "generated";
  if (dirs.some((d) => VENDORED_DIRS.has(d) || GENERATED_DIRS.has(d))) return "generated";
  if (GENERATED_FILES.some((pattern) => pattern.test(name))) return "generated";
  if (dirs.some((d) => TEST_DIRS.has(d))) return "test";
  if (TEST_FILES.some((pattern) => pattern.test(name))) return "test";
  if (TEST_CLASS.test(path.split("/").at(-1) ?? "")) return "test";
  return "code";
}

export const NO_LINES: LineCounts = {
  code: { additions: 0, deletions: 0 },
  test: { additions: 0, deletions: 0 },
  generated: { additions: 0, deletions: 0 },
};

/** A PR's changed files' lines, summed by kind. */
export function countLines(files: readonly { path: string; additions: number; deletions: number }[]): LineCounts {
  const counts: LineCounts = {
    code: { additions: 0, deletions: 0 },
    test: { additions: 0, deletions: 0 },
    generated: { additions: 0, deletions: 0 },
  };
  for (const file of files) {
    const kind = lineKind(file.path);
    counts[kind].additions += file.additions;
    counts[kind].deletions += file.deletions;
  }
  return counts;
}

/** Order of review: the code first, then its tests, what a tool wrote last. */
export const KIND_ORDER: readonly LineKind[] = ["code", "test", "generated"];
