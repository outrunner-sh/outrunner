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
import { KIND_ORDER } from "@/lib/review/line-kinds";
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
};

/** The hunks a tour walks through, in the files' plain order (code, then
 *  tests, by path), and the files it leaves out. */
export function tourHunks(files: readonly PullFile[]): { hunks: Hunk[]; skipped: string[] } {
  const ordered = [...files].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path));
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

function hunkText(hunk: Hunk): string {
  const body = hunk.lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`).join("\n");
  return body.length > HUNK_CHARS ? `${body.slice(0, HUNK_CHARS)}\n… (cut short)` : body;
}

/** What the model is asked, with the PR and its hunks. */
export function tourPrompt(pr: { title: string; body: string }, hunks: readonly Hunk[]): string {
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

Its diff, one hunk per section, each headed by its id (\`path#index\`):

${parts.join("\n\n")}

Order every hunk above for reading: start where the change's purpose is clearest (the core logic, a new type or API), then what builds on it, then call sites and wiring, then tests. Keep each file's hunks together. For each hunk, write a title of a few words and an explanation of one to three plain sentences: what it changes and why it matters to the rest, naming functions and values. Don't restate the diff line by line. Point out anything a reviewer should look at closely.

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
  return { summary: clip(given.summary, 1_500), steps, skipped };
}

/**
 * A PR's tour, written by Outrunner's model on the org's budget (`key`, as
 * "Ask about this PR" uses). A PR with nothing to walk through gets an empty
 * tour without asking; a model that can't be reached throws.
 */
export async function writeTour(key: string, pr: { title: string; body: string }, files: readonly PullFile[]): Promise<Tour> {
  const { hunks, skipped } = tourHunks(files);
  if (hunks.length === 0) return { summary: "", steps: [], skipped };
  const response = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Outrunner Review" },
    body: JSON.stringify({
      model: agentModel(),
      messages: [{ role: "user", content: tourPrompt(pr, hunks) }],
      max_tokens: 6_000,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(`The model call failed (${response.status}): ${body?.error?.message ?? "no detail"}`);
  return normalizeTour(readJsonAnswer(body?.choices?.[0]?.message?.content ?? ""), hunks, skipped);
}
