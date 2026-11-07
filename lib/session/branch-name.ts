/**
 * The branch a new session works on when none is asked for: a few words of
 * what it's for, e.g. `right-sidebar-expandable`, and `-2`, `-3`… only when
 * that name is taken. No guessed type: a wrong `fix/` misleads more than none.
 * Sessions from before have `runtime/<time>-<id>`. Pure, so the sidebar and
 * the Mac can use it too.
 */

/** A generated branch from before, whose prefix says nothing. */
const GENERATED_PREFIX = /^runtime\//;

/** At most this many words, and this many characters, of what it's for. */
const SLUG_WORDS = 4;
const SLUG_MAX = 40;

/** How far `-2`, `-3`… go before a name is given up on. */
export const BRANCH_ATTEMPTS = 20;

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

/** A few words of `text`, lowercase and hyphenated, for a branch; "" for none. */
export function branchSlug(text: string): string {
  const picked = words(text).slice(0, SLUG_WORDS);
  let slug = "";
  for (const word of picked) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // One long word alone is cut, not dropped.
  return slug || (picked[0] ?? "").slice(0, SLUG_MAX);
}

/** A new session's branch, from its title, else its first prompt, before
 *  any `-2` a taken name needs. */
export function sessionBranch(about: { title?: string; prompt?: string }): string {
  return branchSlug(about.title ?? "") || branchSlug(about.prompt ?? "") || "session";
}

/** The `n`th name to try for `base`: itself, then `base-2`, `base-3`… */
export function numberedBranch(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

/** The first of `base`, `base-2`, `base-3`… that `taken` says is free, or
 *  null when all BRANCH_ATTEMPTS are. Asked one at a time, in order. */
export async function firstFreeBranch(
  base: string,
  taken: (branch: string) => boolean | Promise<boolean>,
): Promise<string | null> {
  for (let n = 1; n <= BRANCH_ATTEMPTS; n++) {
    const branch = numberedBranch(base, n);
    if (!(await taken(branch))) return branch;
  }
  return null;
}

/** A branch without a meaningless generated prefix, for showing and matching. */
export function withoutGeneratedPrefix(branch: string): string {
  return branch.replace(GENERATED_PREFIX, "");
}
