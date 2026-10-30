import { authorizeGrant, readGrant } from "@/lib/codex/grant";
import { createCodexProxy } from "@/lib/codex/inference";
import { codexAccounts } from "@/lib/codex/store";
import { optionalEnv } from "@/lib/env";
const proxy = createCodexProxy({
  readGrant,
  accounts: codexAccounts,
  fetch,
  authorize: authorizeGrant,
  brokerOrigin: optionalEnv("RUNTIME_BASE_URL"),
});
export const GET = proxy;
export const POST = proxy;
