"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ConnectionStatus, DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
import {
  agentCli,
  type AgentCliStatus,
  cancelClaudeLogin,
  cancelCodexLogin,
  CODEX_INSTALL_COMMAND,
  type LocalStatus,
  localStatus,
  logInToClaude,
  logInToCodex,
} from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";

const noopSubscribe = () => () => {};

/** The agent's CLI in a status from the app; null from an app too old to
 *  know Codex, which can't sign it in either. */
function cliOf(status: LocalStatus, agent: AgentId): AgentCliStatus | null {
  return agent === "codex" && !status.agents ? null : agentCli(status, agent);
}

const SIGNED_IN_WITH = { chatgpt: "ChatGPT", "api-key": "An API key" } as const;

/**
 * A way of signing in that is the agent's own CLI on the user's Mac: the
 * "Local agent" card, and Codex's "ChatGPT" (which signs that CLI in with
 * ChatGPT). Outrunner never sees that login: sessions on this Mac run the CLI
 * as it is. So this reads the CLI's state from the Mac app, and signs it in
 * there; outside the app there's nothing to show.
 */
export function LocalAgentConnection({
  agent,
  chatgpt = false,
  shown = true,
}: {
  agent: AgentId;
  chatgpt?: boolean;
  /** Whether its card is the one shown. Each time it comes into view it asks
   *  the Mac again: another card (ChatGPT's, say) may have signed the CLI in
   *  meanwhile. */
  shown?: boolean;
}) {
  const { label, command } = AGENTS[agent];
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
  const [cli, setCli] = useState<AgentCliStatus | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest check wins: an older one finishing late mustn't overwrite it.
  const check = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++check.current;
    setChecking(true);
    try {
      const status = await localStatus();
      if (check.current === mine) setCli(status ? cliOf(status, agent) : null);
    } catch (e) {
      if (check.current === mine) setError(e instanceof Error ? e.message : `Couldn't check ${label} on this Mac.`);
    } finally {
      if (check.current === mine) setChecking(false);
    }
  }, [agent, label]);

  useEffect(() => {
    // Reading the Mac's state is what this panel is for: there's no other
    // source to render it from, so it's asked for once shown.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (desktop && shown) void refresh();
  }, [desktop, shown, refresh]);

  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      await (agent === "codex" ? logInToCodex() : logInToClaude());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Signing ${label} in failed.`);
    } finally {
      setSigningIn(false);
    }
  }

  function cancel() {
    void (agent === "codex" ? cancelCodexLogin() : cancelClaudeLogin());
  }

  if (!desktop) {
    return (
      <p className="text-sm text-muted-foreground">
        Open Outrunner in the Mac app to use {label} on your Mac, signed in as it is there.
      </p>
    );
  }

  // Signed in the way this card means: any way for the Local agent, ChatGPT
  // for ChatGPT.
  const ready = cli?.loggedIn === true && (!chatgpt || cli.method === "chatgpt");
  const signInLabel = chatgpt ? "Sign in with ChatGPT" : `Sign ${label} in`;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <SectionHeader title={chatgpt ? "ChatGPT" : "Local agent"} />
          <Button variant="ghost" size="sm" disabled={checking || signingIn} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
        <ConnectionStatus connected={ready} />
        {cli === null ? (
          <p className="text-sm text-muted-foreground">Update the Outrunner app to use {label} on this Mac.</p>
        ) : cli ? (
          <Details>
            <DetailRow term="CLI">
              {cli.path ? <span className="font-mono">{cli.path}</span> : <span className="text-muted-foreground">Not installed</span>}
            </DetailRow>
            <DetailRow term="Signed in">
              {cli.loggedIn === null
                ? "Can't tell"
                : cli.loggedIn
                  ? (cli.method ? SIGNED_IN_WITH[cli.method] : "Yes")
                  : "No"}
            </DetailRow>
            <DetailRow term="Applies to">Sessions on this Mac</DetailRow>
          </Details>
        ) : null}
      </div>

      {cli && !cli.path ? (
        agent === "codex" ? (
          <p className="text-sm text-muted-foreground">
            Install Codex with <code className="font-mono">{CODEX_INSTALL_COMMAND}</code>, then refresh.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Outrunner sets up Claude Code on this Mac when you start a session here.
          </p>
        )
      ) : cli && !ready ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <LoadingButton
              status={signingIn ? "pending" : "idle"}
              labels={{ idle: signInLabel, pending: "Waiting for the browser" }}
              onClick={() => void signIn()}
            />
            {signingIn ? (
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Runs <code className="font-mono">{command} {agent === "codex" ? "login" : "auth login"}</code> on this
            Mac. It signs {label} in for your own terminal too.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
