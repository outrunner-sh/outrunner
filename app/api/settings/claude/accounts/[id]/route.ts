import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { ClaudeAccountError, MAX_CLAUDE_ACCOUNTS, removeAccount, view } from "@/lib/claude/accounts";
import { claudeAccountStore, ClaudeAccountsUnavailable } from "@/lib/claude/accounts.deps";
import { isSameOriginRequest } from "@/lib/http/guards";

/** Disconnect one of the owner's Claude accounts; the next in order becomes
 *  the one sessions start on. Answers the accounts left. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;

  try {
    const store = claudeAccountStore(owner.id);
    const left = await removeAccount(store, id);
    return NextResponse.json({
      accounts: left.map((account) => view(account, store.readable?.(account) ?? true)),
      max: MAX_CLAUDE_ACCOUNTS,
    });
  } catch (error) {
    if (error instanceof ClaudeAccountError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ClaudeAccountsUnavailable) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error("Could not remove a Claude account", error);
    return NextResponse.json({ error: "Couldn't remove that Claude account. It's still connected; try again in a moment." }, { status: 500 });
  }
}
