/**
 * The reason a Claude Code login failed, out of the last lines the CLI printed
 * (joined with " | " by the desktop app).
 *
 * Those lines include the sign-in link, "Opening browser to sign in…" and the
 * "Paste code here" prompt: noise next to the one line that says what went
 * wrong, and the link is long enough to swamp the message. Keep the line that
 * reads like an error, else the last line that isn't noise.
 */
export function cliReason(said: string): string {
  const lines = said
    .split(" | ")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)));
  const failure = lines.filter((line) => /fail|error|couldn.t|can.t|denied|invalid|expired/i.test(line)).at(-1);
  return failure ?? lines.at(-1) ?? "";
}

const NOISE = [
  /https?:\/\//,
  /^opening browser/i,
  /^if the browser didn.t open/i,
  /paste code/i,
  /^press enter/i,
];
