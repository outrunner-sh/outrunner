/**
 * The branch a new session works on when none is asked for, in the usual
 * `<type>/<description>` convention plus a short suffix so two sessions never
 * share one, e.g. `fix/google-sign-in-3fa9c1`. Sessions from before have
 * `runtime/<time>-<id>`. Pure, so the sidebar and the Mac can use it too.
 */

/** Conventional types, in the order they're tested: the first that fits. */
const TYPES: { type: string; words: RegExp }[] = [
  { type: "fix", words: /^(?:fix|fixes|fixed|fixing|bug|bugs|broken|break|breaks|crash|crashes|crashing|error|errors|fail|fails|failing|failed|failure|wrong|incorrect|glitch|regression|doesnt|isnt|wont|cant)$/ },
  { type: "docs", words: /^(?:doc|docs|documentation|document|readme|changelog)$/ },
  { type: "test", words: /^(?:test|tests|testing|spec|specs|coverage)$/ },
  { type: "refactor", words: /^(?:refactor|refactoring|cleanup|simplify|restructure|reorganize|tidy)$/ },
  { type: "perf", words: /^(?:perf|performance|faster|slow|slowness|speed|optimize|optimise|latency)$/ },
  { type: "chore", words: /^(?:review|verify|check|audit|investigate|research|bump|upgrade|deps|dependencies|ci|lint|chore)$/ },
];
/** What's left when nothing else fits: building something. */
const DEFAULT_TYPE = "feat";

/** Every type's own name, kept out of the description (no `fix/fix-…`). */
const TYPE_NAMES = /^(?:fix|fixes|fixed|fixing|feat|feature|docs|test|tests|refactor|perf|chore)$/;

/** A generated branch from before, whose prefix says nothing. */
const GENERATED_PREFIX = /^runtime\//;

/** At most this many words, and this many characters, of what it's for. */
const SLUG_WORDS = 4;
const SLUG_MAX = 40;

/** Words that say nothing about the work: grammar, politeness, chat. */
const FILLER = new Set(
  (
    "a an the and or but to of for in on at by with from into about as this that these those it its is are be been was were " +
    "please can could would should will you we i me my our us let lets just so now then also some any here there do does did " +
    "im ive id youre hey hi hello ok okay yeah yes thanks thank kindly hmm um " +
    "think thinking thought probably maybe guess want wanted need needs like really actually basically seems seem " +
    "one found noticed saw see look looking why how what when where which who whats get got go going make sure since because giving"
  ).split(" "),
);

/** The words of `text` worth naming a branch by, in order, each once. */
function words(text: string): string[] {
  const found = text
    // A link's issue or pull request is worth keeping; the rest of it isn't.
    .replace(/https?:\/\/\S*?\/(issues|pull)\/(\d+)\S*/g, (_, kind: string, n: string) => ` ${kind === "pull" ? "pr" : "issue"} ${n} `)
    .replace(/https?:\/\/\S+/g, " ")
    // "it's" is one word, not "it" and "s".
    .replace(/['’]/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // A lone letter says nothing.
    .filter((word) => (word.length > 1 || /\d/.test(word)) && !FILLER.has(word))
    // "issue 266" says which; "this issue" alone says nothing.
    .filter((word, i, all) => !/^(?:issue|issues|problem|pr)$/.test(word) || /^\d+$/.test(all[i + 1] ?? ""));
  return [...new Set(found)];
}

/** The conventional type `text` asks for. */
export function branchType(text: string): string {
  const all = words(text);
  return TYPES.find(({ words: match }) => all.some((word) => match.test(word)))?.type ?? DEFAULT_TYPE;
}

/** A few words of `text`, lowercase and hyphenated, for a branch; "" for none. */
export function branchSlug(text: string): string {
  const picked = words(text)
    .filter((word) => !TYPE_NAMES.test(word))
    .slice(0, SLUG_WORDS);
  let slug = "";
  for (const word of picked) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // One long word alone is cut, not dropped.
  return slug || (picked[0] ?? "").slice(0, SLUG_MAX);
}

/** A new session's branch, from its title, else its first prompt. */
export function sessionBranch(about: { title?: string; prompt?: string }, suffix: string): string {
  const from = [about.title ?? "", about.prompt ?? ""].find((text) => branchSlug(text)) ?? "";
  return `${branchType(from)}/${branchSlug(from) || "session"}-${suffix}`;
}

/** A branch without a meaningless generated prefix, for showing and matching. */
export function withoutGeneratedPrefix(branch: string): string {
  return branch.replace(GENERATED_PREFIX, "");
}
