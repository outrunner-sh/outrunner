"use client";

import { useRef, useState } from "react";

import { ChecklistRow, type RowState } from "@/components/onboarding/checklist-row";
import { Button } from "@/components/ui/button";
import type { OnboardingEnv } from "@/lib/onboarding/types";

type Connect = { state: "idle" } | { state: "waiting" } | { state: "error"; message: string };

/**
 * The one Claude connection a user makes: their Claude subscription, approved
 * once in the browser and stored with their account. The same connection
 * Settings → Providers → Claude subscription shows, on both onboarding paths,
 * so connecting here reads as connected there.
 *
 * Shown only to a user who has Claude to connect, or where nothing else can
 * run a session (lib/onboarding/claude-choice.ts).
 */
export function ConnectClaudeRow({
  env,
  connected,
  onConnected,
  todo,
  optional = false,
  children,
}: {
  env: OnboardingEnv;
  /** Null while it is still being checked. */
  connected: boolean | null;
  onConnected: () => void;
  /** What it is for, while it is not connected (the default speaks of the subscription). */
  todo?: React.ReactNode;
  /** Sessions start without it: its button doesn't press for attention. */
  optional?: boolean;
  /** Alternatives offered below the row while it is not connected. */
  children?: React.ReactNode;
}) {
  const [connect, setConnect] = useState<Connect>({ state: "idle" });
  // The attempt the row is waiting on; Cancel moves it on, so the cancelled
  // attempt's own failure ("that sign-in ended") doesn't show as an error.
  const attempt = useRef(0);

  const run = async () => {
    const mine = ++attempt.current;
    setConnect({ state: "waiting" });
    try {
      await env.connectClaude();
      if (attempt.current !== mine) return;
      setConnect({ state: "idle" });
      onConnected();
    } catch (error) {
      if (attempt.current !== mine) return;
      setConnect({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const state: RowState =
    connected === null
      ? "working"
      : connected
        ? "done"
        : connect.state === "waiting"
          ? "working"
          : connect.state === "error"
            ? "problem"
            : "todo";

  return (
    <ChecklistRow
      state={state}
      title="Connect Claude"
      detail={
        connected === null
          ? "Checking…"
          : connected
            ? "Connected. Your sessions run on your Claude subscription."
            : connect.state === "waiting"
              ? // The first connect on a Mac without Claude Code sets it up before the browser opens.
                "Approve in your browser when it opens. This finishes on its own."
              : connect.state === "error"
                ? connect.message
                : !env.desktop
                  ? "Connecting Claude needs the Outrunner Mac app."
                  : (todo ?? "Use your Claude Pro or Max subscription. Approve once in your browser.")
      }
      action={
        connected !== false ? undefined : connect.state === "waiting" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              attempt.current++;
              env.cancelConnectClaude();
              setConnect({ state: "idle" });
            }}
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant={optional ? "outline" : "default"}
            disabled={!env.desktop}
            onClick={() => void run()}
          >
            {connect.state === "error" ? "Try again" : "Connect Claude"}
          </Button>
        )
      }
    >
      {connected === false && connect.state !== "waiting" ? children : null}
    </ChecklistRow>
  );
}
