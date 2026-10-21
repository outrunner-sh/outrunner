/** Said when a prompt didn't reach the agent and the agent's words weren't
 *  written for the user. */
export const SEND_FAILED = "Couldn't deliver that message. Try again.";

/** Claude holding a question or permission prompt: the one send failure the
 *  agent words for the user, and the only one with something to do first. */
const AWAITS_ANSWER = /^Claude is waiting for an answer\b/;

/** What the composer says for a send the agent refused. Its other errors name
 *  internals ("jcode: no session for workspace …", "prompt not confirmed
 *  delivered after 3 attempts"); those go to the server's log, not the page. */
export function sendFailureMessage(agentSaid: string | null | undefined): string {
  const said = agentSaid?.trim() ?? "";
  if (AWAITS_ANSWER.test(said)) return /[.!?]$/.test(said) ? said : `${said}.`;
  return SEND_FAILED;
}
