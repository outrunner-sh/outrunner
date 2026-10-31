/**
 * An answer to the question a session's agent asked (POST
 * /workspaces/{id}/answer), checked before it goes to the question card's own
 * route. No network here.
 */

/** The answers to the question's questions as posted (`answers`: one each,
 *  `selected` labels and an `other` answer of its own), or the reason not. */
export function parseAnswers(value: unknown, asked: number): { selected: string[]; other: string }[] | string {
  if (!Array.isArray(value) || value.length === 0) return "`answers` is a list: one for each question, in order.";
  if (value.length > asked) return `It asked ${asked} question${asked === 1 ? "" : "s"}.`;
  const answers: { selected: string[]; other: string }[] = [];
  for (const answer of value) {
    if (!answer || typeof answer !== "object") return "Each answer is { selected: [labels], other: text }.";
    const { selected = [], other = "" } = answer as { selected?: unknown; other?: unknown };
    if (!Array.isArray(selected) || !selected.every((label) => typeof label === "string")) return "`selected` is a list of the options' labels.";
    if (typeof other !== "string") return "`other` is text.";
    if (selected.length === 0 && !other.trim()) return "Pick an option (`selected`) or answer in your own words (`other`).";
    answers.push({ selected: selected as string[], other });
  }
  return answers;
}
