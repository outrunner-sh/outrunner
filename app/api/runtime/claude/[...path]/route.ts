import { authorizeClaudeGrant, readClaudeGrant } from "@/lib/claude/grant";
import { createClaudeProxy } from "@/lib/claude/inference";
const proxy = createClaudeProxy({
  readGrant: readClaudeGrant,
  authorize: authorizeClaudeGrant,
  fetch,
});
export const POST = proxy;
