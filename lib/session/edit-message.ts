import { promptAttachments } from "@/lib/runtime/attachments";
import { parseCommentQuotes } from "@/lib/session/diff-comments";

/** Editing begins with typed words; attachments and diff quotes need reselecting. */
export function editPromptText(text: string): string {
  return parseCommentQuotes(promptAttachments(text).text).text;
}
