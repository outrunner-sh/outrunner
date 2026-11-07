/**
 * The branch a new session works on when none is asked for: Outrunner's
 * prefix, a few words of what it's for and a short random suffix, as other
 * coding agents name theirs (`claude/…`, `codex/…`, `cursor/…`), e.g.
 * `outrunner/fix-login-redirect-3fa9c1`. Sessions from before have
 * `runtime/<time>-<id>`. Pure, so the sidebar can use it too.
 */

export const BRANCH_PREFIX = "outrunner/";

/** A generated branch's prefix, either kind. */
const GENERATED_PREFIX = /^(?:outrunner|runtime)\//;

/** At most this many words, and this many characters, of what it's for. */
const SLUG_WORDS = 6;
const SLUG_MAX = 40;

/** Words that say nothing about the work. */
const FILLER = new Set(
  "a an the and or but to of for in on at by with from into this that these those it its is are be was were please can could would should will you we i me my our us let lets just so now then also some any here there do does did im youre".split(
    " ",
  ),
);

/** A few words of `text`, lowercase and hyphenated, for a branch; "" for none. */
export function branchSlug(text: string): string {
  const found = text
    .replace(/https?:\/\/\S+/g, " ")
    // "it's" is one word, not "it" and "s".
    .replace(/['’]/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // A lone letter says nothing.
    .filter((word) => (word.length > 1 || /\d/.test(word)) && !FILLER.has(word));
  // Each word once.
  const words = [...new Set(found)].slice(0, SLUG_WORDS);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // One long word alone is cut, not dropped.
  return slug || (words[0] ?? "").slice(0, SLUG_MAX);
}

/** A new session's branch, from its title, else its first prompt. */
export function sessionBranch(about: { title?: string; prompt?: string }, suffix: string): string {
  const slug = branchSlug(about.title ?? "") || branchSlug(about.prompt ?? "");
  return `${BRANCH_PREFIX}${slug || "session"}-${suffix}`;
}

/** A branch without the prefix Outrunner gave it, for showing and matching. */
export function withoutGeneratedPrefix(branch: string): string {
  return branch.replace(GENERATED_PREFIX, "");
}
