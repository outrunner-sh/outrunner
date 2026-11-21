import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  checkLabel,
  ClaudeAccountError,
  MAX_CLAUDE_ACCOUNTS,
  reorderAccounts,
  saveAccount,
  view,
  type ClaudeAccount,
} from "@/lib/claude/accounts";
import { claudeAccountStore, ClaudeAccountsUnavailable, loadClaudeAccounts } from "@/lib/claude/accounts.deps";
import { settleClaudeSlot } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { checkClaudeToken } from "@/lib/runtime/credentials/claude-token";

/**
 * The owner's Claude subscriptions (lib/claude/accounts.ts), for Settings →
 * Claude subscription. GET lists them, never a token; POST connects a token
 * under a label, or replaces the token under that label; PATCH reorders them.
 * Removing one is DELETE /api/settings/claude/accounts/[id].
 */

export type ClaudeAccountsResponse = { accounts: ReturnType<typeof view>[]; max: number };

function answer(accounts: ClaudeAccount[]): NextResponse<ClaudeAccountsResponse> {
  return NextResponse.json({ accounts: accounts.map(view), max: MAX_CLAUDE_ACCOUNTS });
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
}

/** What went wrong, for the person: theirs to fix, not ready yet, or ours. */
function failed(error: unknown, doing: string) {
  if (error instanceof ClaudeAccountError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ClaudeAccountsUnavailable) return NextResponse.json({ error: error.message }, { status: 503 });
  console.error(`Could not ${doing}`, error);
  return NextResponse.json({ error: `Couldn't ${doing}. Try again in a moment.` }, { status: 500 });
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The owner's accounts, adopting the Claude slot's token if they have none yet. */
async function load(ownerId: string): Promise<ClaudeAccount[]> {
  await settleClaudeSlot(ownerId);
  const accounts = await loadClaudeAccounts(ownerId);
  if (!accounts) throw new ClaudeAccountsUnavailable();
  return accounts;
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return unauthorized();
  try {
    return answer(await load(owner.id));
  } catch (error) {
    return failed(error, "load your Claude accounts");
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return unauthorized();
  const input = await body(request);
  if (!input) return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  const label = checkLabel(input.label);
  if ("error" in label) return NextResponse.json({ error: label.error }, { status: 400 });
  const token = checkClaudeToken(input.token);
  if ("error" in token) return NextResponse.json({ error: token.error }, { status: 400 });

  try {
    await load(owner.id);
    return answer(await saveAccount(claudeAccountStore(owner.id), label.label, token.token));
  } catch (error) {
    return failed(error, "save your Claude account");
  }
}

export async function PATCH(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return unauthorized();
  const input = await body(request);
  const order = input?.order;
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "Expected the accounts' ids in their new order." }, { status: 400 });
  }

  try {
    await load(owner.id);
    return answer(await reorderAccounts(claudeAccountStore(owner.id), order));
  } catch (error) {
    return failed(error, "reorder your Claude accounts");
  }
}
