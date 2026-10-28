/** Marks a message the server sends a session on Slack's or GitHub's behalf,
 *  so the session's route doesn't echo it to the session's Slack thread as
 *  typed by its owner (lib/slack/relay.ts). */
export const FROM_HEADER = "x-outrunner-from";

/** Where a message the server sends came from: "github-ci" is CI failing,
 *  not a person (lib/github/followups.ts). */
export type MessageSource = "slack" | "github" | "github-ci";
