/**
 * The guided tour of a pull request: Outrunner's model reads its diff and
 * walks the reviewer through it in an order that makes sense (what the
 * change is for first, what follows from it after), file by file and hunk by
 * hunk, with a short explanation of each. Generated files (lockfiles,
 * snapshots, vendored code) are left out: there's nothing in them to explain.
 *
 * The model's answer is held to the PR's real hunks (normalizeTour): one it
 * made up is dropped, one it skipped is added where its file is, and a file's
 * hunks stay together. Without an answer, the tour still runs in the plain
 * order (code, then tests), only without its notes.
 */

import { type Hunk, type PullFile, splitHunks } from "@/lib/review/hunks";
import { byKindThenPath } from "@/lib/review/line-kinds";
import { agentModel } from "@/lib/slack/agent-model";

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export type TourStep = {
  hunkId: string;
  path: string;
  /** A few words: what this part does. */
  title: string;
  /** A sentence or three of plain language, in Markdown. */
  explanation: string;
};

export type Tour = {
  /** What the PR does, in a short paragraph, shown before the first step. */
  summary: string;
  steps: TourStep[];
  /** Files not in the tour: generated ones, and ones without a diff. */
  skipped: string[];
  /** False when GitHub listed only some of the PR's files, so the tour
   *  covers only those. */
  complete: boolean;
};

/** The hunks a tour walks through, in the files' plain order (code, then
 *  tests, by path), and the files it leaves out. */
export function tourHunks(files: readonly PullFile[]): { hunks: Hunk[]; skipped: string[] } {
  const ordered = [...files].sort(byKindThenPath);
  const hunks: Hunk[] = [];
  const skipped: string[] = [];
  for (const file of ordered) {
    const these = file.kind === "generated" ? [] : splitHunks(file.path, file.patch);
    if (these.length === 0) skipped.push(file.path);
    hunks.push(...these);
  }
  return { hunks, skipped };
}

/** How much of the diff the model is shown: each hunk up to its share, and
 *  every hunk's id and header even past the whole budget, so it can still
 *  place them. */
const HUNK_CHARS = 4_000;
const DIFF_BUDGET = 90_000;
const DESCRIPTION_MAX = 4_000;
/** Past this many hunks, each note is asked to be one sentence, so the
 *  answer fits its tokens (tourTokens). */
const LONG_TOUR = 60;

function hunkText(hunk: Hunk): string {
  const body = hunk.lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`).join("\n");
  return body.length > HUNK_CHARS ? `${body.slice(0, HUNK_CHARS)}\n… (cut short)` : body;
}

/** What the model is asked, with the PR and its hunks. */
export function tourPrompt(pr: { title: string; body: string }, hunks: readonly Hunk[], complete = true): string {
  let budget = DIFF_BUDGET;
  const parts = hunks.map((hunk) => {
    const text = hunkText(hunk);
    const shown = budget > 0 ? text : "(not shown: the diff is long)";
    budget -= text.length;
    return `### ${hunk.id}\n${hunk.header}\n${shown}`;
  });
  return `You are giving a reviewer a guided tour of a pull request: "${pr.title}".

Its description:
${pr.body.trim().slice(0, DESCRIPTION_MAX) || "(none)"}

Its diff, one hunk per section, each headed by its id (\`path#index\`)${complete ? "" : " (only some of its files: GitHub listed no more, so don't present the summary as covering all of it)"}:

${parts.join("\n\n")}

Order every hunk above for reading: start where the change's purpose is clearest (the core logic, a new type or API), then what builds on it, then call sites and wiring, then tests. Keep each file's hunks together. For each hunk, write a title of a few words and an explanation of one to three plain sentences: what it changes and why it matters to the rest, naming functions and values. Don't restate the diff line by line. Point out anything a reviewer should look at closely.${hunks.length > LONG_TOUR ? " There are many hunks: keep each explanation to one sentence." : ""}

Answer with JSON only, no prose around it:
{"summary": "<two or three sentences: what the PR does and how it goes about it>", "steps": [{"hunk": "<id>", "title": "<few words>", "explanation": "<1-3 sentences>"}]}`;
}

/** The JSON in a model's answer: the whole of it, or within a code fence or
 *  the outermost braces. Null when there's none. */
export function readJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [text, fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate?.trim()) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // The next way of finding it.
    }
  }
  return null;
}

/**
 * What can be saved of an answer cut off before its end (it ran out of
 * tokens): its summary, and every step object that was finished. Null when
 * not even one step was.
 */
export function salvageAnswer(text: string): { summary: string; steps: unknown[] } | null {
  const steps: unknown[] = [];
  for (const match of text.matchAll(/\{[^{}]*"hunk"\s*:[^{}]*\}/g)) {
    try {
      steps.push(JSON.parse(match[0]));
    } catch {
      // Cut off inside this one.
    }
  }
  if (steps.length === 0) return null;
  const summary = /"summary"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
  let read = "";
  try {
    read = summary ? (JSON.parse(summary) as string) : "";
  } catch {
    read = "";
  }
  return { summary: read, steps };
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * The model's answer as a tour of exactly the PR's hunks: the steps it gave
 * for real hunks, each once, grouped by file in the order it first reached
 * each; then any hunk it skipped, with its file. With no usable answer, the
 * plain order without notes.
 */
export function normalizeTour(answer: unknown, hunks: readonly Hunk[], skipped: string[]): Tour {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const given = (answer ?? {}) as { summary?: unknown; steps?: unknown };
  const notes = new Map<string, { title: string; explanation: string }>();
  const fileOrder: string[] = [];
  const hunkOrder = new Map<string, string[]>();
  const place = (hunk: Hunk) => {
    if (!hunkOrder.has(hunk.path)) {
      fileOrder.push(hunk.path);
      hunkOrder.set(hunk.path, []);
    }
    hunkOrder.get(hunk.path)!.push(hunk.id);
  };
  for (const step of Array.isArray(given.steps) ? (given.steps as { hunk?: unknown; title?: unknown; explanation?: unknown }[]) : []) {
    const hunk = typeof step?.hunk === "string" ? byId.get(step.hunk.trim()) : undefined;
    if (!hunk || notes.has(hunk.id)) continue;
    notes.set(hunk.id, { title: clip(step.title, 120), explanation: clip(step.explanation, 1_200) });
    place(hunk);
  }
  for (const hunk of hunks) {
    if (notes.has(hunk.id)) continue;
    notes.set(hunk.id, { title: "", explanation: "" });
    place(hunk);
  }
  const steps: TourStep[] = fileOrder.flatMap((path) =>
    hunkOrder.get(path)!.map((id) => ({ hunkId: id, path, ...notes.get(id)! })),
  );
  return { summary: clip(given.summary, 1_500), steps, skipped, complete: true };
}

/**
 * A PR's tour, written by Outrunner's model on the org's budget (`key`, as
 * "Ask about this PR" uses). A PR with nothing to walk through gets an empty
 * tour without asking; a model that can't be reached throws.
 */
export async function writeTour(
  key: string,
  pr: { title: string; body: string },
  files: readonly PullFile[],
  complete = true,
): Promise<Tour> {
  const { hunks, skipped } = tourHunks(files);
  if (hunks.length === 0) return { summary: "", steps: [], skipped, complete };
  const response = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Outrunner Review" },
    body: JSON.stringify({
      model: agentModel(),
      messages: [{ role: "user", content: tourPrompt(pr, hunks, complete) }],
      max_tokens: tourTokens(hunks.length),
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(`The model call failed (${response.status}): ${body?.error?.message ?? "no detail"}`);
  const choice = body?.choices?.[0];
  const text = choice?.message?.content ?? "";
  let answer = readJsonAnswer(text);
  if (answer === null) {
    // Most likely cut off: the steps it finished still have their notes.
    answer = salvageAnswer(text);
    console.warn(
      `Review: the tour's answer wasn't whole JSON (finish_reason ${choice?.finish_reason ?? "unknown"}, ${text.length} characters, ${hunks.length} hunks); ${answer ? "kept the steps it finished" : "walking the plain order"}`,
    );
  }
  return { ...normalizeTour(answer, hunks, skipped), complete };
}

/** Tokens the answer may take: about 120 a step (its id, title and a few
 *  sentences) and some for the summary, up to a ceiling a long PR stays
 *  under by shortening its notes. */
export function tourTokens(hunks: number): number {
  return Math.min(16_000, 1_500 + 150 * hunks);
}
