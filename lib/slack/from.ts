/** Marks a message the server sends a session on Slack's behalf, so the
 *  session's route doesn't post it back to Slack (lib/slack/relay.ts). */
export const FROM_HEADER = "x-outrunner-from";
