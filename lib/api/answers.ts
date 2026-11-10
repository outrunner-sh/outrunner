/**
 * An answer to the question a session's agent asked (POST
 * /workspaces/{id}/answer), checked before it goes to the question card's own
 * route. No network here.
 */

/** An option's label, as a question lists it (`{ label }`, or plain text). */
function optionLabel(option: unknown): string | null {
  if (typeof option === "string") return option;
  const label = (option as { label?: unknown } | null)?.label;
  return typeof label === "string" ? label : null;
}

/** The answers to the agent's questions as posted (`answers`: one per
 *  question, in order; `selected` among its options' labels, one unless it
 *  takes several, or an `other` answer of its own), or the reason not. */
export function parseAnswers(value: unknown, questions: readonly unknown[]): { selected: string[]; other: string }[] | string {
  const asked = questions.length;
  const one = `It asked ${asked} question${asked === 1 ? "" : "s"}: send one answer for each, in order.`;
  if (!Array.isArray(value) || value.length !== asked) return one;
  const answers: { selected: string[]; other: string }[] = [];
  for (const [i, answer] of value.entries()) {
    if (!answer || typeof answer !== "object") return "Each answer is { selected: [labels], other: text }.";
    const { selected = [], other = "" } = answer as { selected?: unknown; other?: unknown };
    if (!Array.isArray(selected) || !selected.every((label) => typeof label === "string")) return "`selected` is a list of the options' labels.";
    if (typeof other !== "string") return "`other` is text.";
    if (selected.length === 0 && !other.trim()) return "Pick an option (`selected`) or answer in your own words (`other`).";
    const question = (questions[i] ?? {}) as { options?: unknown; multiSelect?: unknown };
    const labels = Array.isArray(question.options) ? question.options.map(optionLabel).filter((l): l is string => l !== null) : [];
    const unknown = (selected as string[]).find((label) => !labels.includes(label));
    if (unknown !== undefined) return `"${unknown}" isn't one of question ${i + 1}'s options: ${labels.join(", ")}.`;
    if (selected.length > 1 && question.multiSelect !== true) return `Question ${i + 1} takes one option.`;
    answers.push({ selected: selected as string[], other });
  }
  return answers;
}

/** The names of the variables a request for secrets asks for: its keys are
 *  `{ name, optional? }` (lib/runtime/pending-secrets.ts). */
export function secretNames(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return keys.flatMap((key) => {
    if (typeof key === "string") return [key];
    const name = (key as { name?: unknown } | null)?.name;
    return typeof name === "string" ? [name] : [];
  });
}

/** What POST /workspaces/{id}/model sends the switch route: an effort alone
 *  goes with the model the session is on (the route needs a model), or the
 *  reason not. */
export function modelSwitch(
  raw: { model?: unknown; provider?: unknown; effort?: unknown },
  current: { provider: string; id: string } | null,
): Record<string, string> | string {
  for (const key of ["model", "provider", "effort"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") return `\`${key}\` must be text.`;
  }
  if (raw.model === undefined && raw.effort === undefined) return "Name the `model` to switch to, or an `effort`.";
  if (raw.model === undefined) {
    if (!current) return "The session has no model on record to change the effort of: name the `model` too.";
    return { model: current.id, provider: current.provider, effort: raw.effort as string };
  }
  return Object.fromEntries((["model", "provider", "effort"] as const).filter((k) => raw[k] !== undefined).map((k) => [k, raw[k] as string]));
}
