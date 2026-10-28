/** Marks a message the server sends a session on Slack's or GitHub's behalf,
 *  so the session's route doesn't echo it to the session's Slack thread as
 *  typed by its owner (lib/slack/relay.ts). */
export const FROM_HEADER = "x-outrunner-from";

/** Where a message the server sends came from. */
export type MessageSource = "slack" | "github";
