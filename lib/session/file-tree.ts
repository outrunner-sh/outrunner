/** The Files panel's tree, built from the worktree's paths. */
export type FileTreeDir = {
  /** As shown: a folder holding only one folder shows both, "a / b". */
  name: string;
  /** Its path from the worktree's root; "" for the root. */
  path: string;
  dirs: FileTreeDir[];
  files: { name: string; path: string }[];
};

/**
 * The tree of `paths` (files, "/"-separated), folders before files and each
 * sorted by name. A chain of folders that each hold only the next one folds
 * into a single row, as editors show `.github / workflows`.
 */
export function buildFileTree(paths: string[]): FileTreeDir {
  const root: FileTreeDir = { name: "", path: "", dirs: [], files: [] };
  const dirs = new Map<string, FileTreeDir>([["", root]]);
  const dirOf = (path: string): FileTreeDir => {
    const known = dirs.get(path);
    if (known) return known;
    const slash = path.lastIndexOf("/");
    const dir: FileTreeDir = { name: path.slice(slash + 1), path, dirs: [], files: [] };
    dirOf(slash === -1 ? "" : path.slice(0, slash)).dirs.push(dir);
    dirs.set(path, dir);
    return dir;
  };
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    dirOf(slash === -1 ? "" : path.slice(0, slash)).files.push({ name: path.slice(slash + 1), path });
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const finish = (dir: FileTreeDir): FileTreeDir => {
    dir.dirs = dir.dirs.map((child) => {
      let folded = child;
      while (folded.files.length === 0 && folded.dirs.length === 1) {
        const only = folded.dirs[0];
        folded = { ...only, name: `${folded.name} / ${only.name}` };
      }
      return finish(folded);
    });
    dir.dirs.sort(byName);
    dir.files.sort(byName);
    return dir;
  };
  return finish(root);
}

/**
 * The paths matching a search, at most `limit`: every word of it somewhere in
 * the path, case aside. Those whose file name holds the whole search come
 * first, then the shorter paths.
 */
export function searchFiles(paths: string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const rank = (path: string) => (path.slice(path.lastIndexOf("/") + 1).toLowerCase().includes(needle) ? 0 : 1);
  return paths
    .filter((path) => {
      const lower = path.toLowerCase();
      return words.every((word) => lower.includes(word));
    })
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}

/** highlight.js's name for a file's language by its extension or name; only
 *  those in its common bundle, which the code view loads. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "scss", less: "less",
  md: "markdown", mdx: "markdown",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", plist: "xml",
  go: "go", py: "python", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", lua: "lua", pl: "perl", r: "r",
  sh: "bash", bash: "bash", zsh: "bash",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  sql: "sql", graphql: "graphql", gql: "graphql", diff: "diff", patch: "diff",
};
const NAMED: Record<string, string> = { dockerfile: "bash", makefile: "makefile", gemfile: "ruby", rakefile: "ruby" };

export function codeLanguage(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMED[name]) return NAMED[name];
  const dot = name.lastIndexOf(".");
  return dot === -1 ? null : LANGUAGES[name.slice(dot + 1)] ?? null;
}
