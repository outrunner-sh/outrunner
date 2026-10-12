"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelClaudeLogin,
  localStatus,
  logInToClaude,
  missingTools,
  needsClaudeLogin,
  type LocalStatus,
} from "@/lib/desktop/local-runtime";

/** Whether this window can run local sessions, and what it would run them on. */
export type LocalRuntime =
  | { state: "checking" }
  /** Not the Outrunner Mac app: local sessions cannot run here. */
  | { state: "unavailable" }
  | { state: "ready"; status: LocalStatus; missing: string[] }
  | { state: "error"; message: string };

async function readRuntime(): Promise<LocalRuntime> {
  try {
    const status = await localStatus();
    return status ? { state: "ready", status, missing: missingTools(status) } : { state: "unavailable" };
  } catch (error) {
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function useLocalRuntime(): { runtime: LocalRuntime; recheck: () => Promise<void> } {
  const [runtime, setRuntime] = useState<LocalRuntime>({ state: "checking" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void readRuntime().then((next) => {
      if (mounted.current) setRuntime(next);
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  const recheck = useCallback(async () => {
    const next = await readRuntime();
    if (mounted.current) setRuntime(next);
  }, []);
  // Follow the app's download of its own Claude Code until it lands or fails.
  const settingUp = runtime.state === "ready" && runtime.status.claudeSetup?.state === "installing";
  useEffect(() => {
    if (!settingUp) return;
    const timer = setTimeout(() => void recheck(), SETUP_CHECK_MS);
    return () => clearTimeout(timer);
  }, [settingUp, runtime, recheck]);
  return { runtime, recheck };
}

/** How often to look in on Claude Code being set up. */
const SETUP_CHECK_MS = 1500;

/** A Claude Code login started from the page. */
export type ClaudeLogin =
  | { state: "idle" }
  /** The browser is open; waiting for the user to approve there. */
  | { state: "waiting" }
  | { state: "error"; message: string };

/** How often to ask whether the login has landed while the CLI is still up. */
const LOGIN_CHECK_MS = 3000;

/**
 * Log this Mac's Claude Code in from the page, for a user who has never run it.
 * Ends when the CLI exits or, failing that, when `claude auth status` says the
 * login landed: either way `onLoggedIn` refreshes what the page knows. A
 * failure is shown with what Claude Code said, never left waiting in silence.
 */
export function useClaudeLocalLogin(onLoggedIn: () => Promise<void>) {
  const [login, setLogin] = useState<ClaudeLogin>({ state: "idle" });
  // The attempt the page is waiting on. A cancel or unmount moves it on, so a
  // stale answer is dropped.
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );

  const start = useCallback(async () => {
    const mine = ++attempt.current;
    const current = () => attempt.current === mine;
    setLogin({ state: "waiting" });
    try {
      // The CLI normally exits once logged in. The status check covers one that
      // logs in and stays up.
      await Promise.race([logInToClaude(), loggedIn(current)]);
      if (!current()) return;
      attempt.current++; // stops the status check
      void cancelClaudeLogin().catch(() => {});
      await onLoggedIn();
      setLogin({ state: "idle" });
    } catch (error) {
      if (!current()) return;
      attempt.current++;
      setLogin({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [onLoggedIn]);

  const cancel = useCallback(() => {
    attempt.current++;
    void cancelClaudeLogin().catch(() => {});
    setLogin({ state: "idle" });
  }, []);

  return { login, start, cancel };
}

/** Resolves once this Mac's Claude Code reports a login; stays pending, and
 *  stops asking, once `current` turns false. */
function loggedIn(current: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = async () => {
      if (!current()) return;
      const status = await localStatus().catch(() => null);
      if (!current()) return;
      if (status && !needsClaudeLogin(status)) resolve();
      else setTimeout(check, LOGIN_CHECK_MS);
    };
    setTimeout(check, LOGIN_CHECK_MS);
  });
}
