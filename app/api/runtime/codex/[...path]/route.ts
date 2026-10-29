import { authorizeGrant, readGrant } from "@/lib/codex/grant";
import { createCodexProxy } from "@/lib/codex/inference";
import { codexAccounts } from "@/lib/codex/store";
const proxy = createCodexProxy({
  readGrant,
  accounts: codexAccounts,
  fetch,
  authorize: authorizeGrant,
});
export const GET = proxy;
export const POST = proxy;
