"use client";

import { ChevronDown, Cloud, Folder, FolderGit2, Laptop } from "lucide-react";

import type { SessionLocationState } from "@/hooks/use-session-location";
import { cn } from "@/lib/utils";

/**
 * Cloud or This Mac. This Mac is offered in the Outrunner Mac app only, the one
 * place that can run the agent on the user's machine; elsewhere it is shown,
 * disabled, so the option is discoverable.
 */
export function SessionLocationToggle({
  state,
  disabled,
  className,
}: {
  state: SessionLocationState;
  disabled?: boolean;
  className?: string;
}) {
  const { location, setLocation, runtime } = state;
  const localPossible = runtime.state === "ready";
  return (
    <div
      role="radiogroup"
      aria-label="Where the session runs"
      className={cn("bg-muted/60 inline-flex rounded-lg p-0.5 text-xs", className)}
    >
      <LocationOption
        selected={location === "cloud"}
        disabled={disabled}
        onSelect={() => setLocation("cloud")}
        icon={<Cloud className="size-3.5" />}
        label="Cloud"
        title="Run on a cloud Runtime Computer, on one of your GitHub repositories"
      />
      <LocationOption
        selected={location === "local"}
        disabled={disabled || !localPossible}
        onSelect={() => setLocation("local")}
        icon={<Laptop className="size-3.5" />}
        label="This Mac"
        title={
          localPossible
            ? "Run Claude Code on this Mac, in any folder"
            : "Local sessions run in the Outrunner Mac app"
        }
      />
    </div>
  );
}

/**
 * The folder a local session works in — in local mode it stands where the
 * repository picker does. A git folder gets a worktree per session; any other
 * folder is worked on directly, which the hint says before anything starts.
 */
export function LocalFolderButton({
  state,
  disabled,
  className,
}: {
  state: SessionLocationState;
  disabled?: boolean;
  className?: string;
}) {
  const { folder, chooseFolder } = state;
  const chosen = folder.state === "ok" ? folder.folder : null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void chooseFolder()}
      title={chosen ? `${chosen.path}\nClick to choose another folder` : "Choose a folder to work in"}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50",
        className,
      )}
    >
      {chosen?.git === false ? (
        <Folder className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{chosen ? chosen.name : "Choose folder…"}</span>
      {chosen && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs font-normal">
          {chosen.git ? `worktree off ${chosen.branch ?? "HEAD"}` : "edits in place"}
        </span>
      )}
      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * Why a local session cannot start yet. When the reason is Claude Code not
 * being logged in on this Mac, it offers the login right there: the app opens
 * the browser, and the note clears once the user approves.
 */
export function LocalBlocker({
  state,
  className,
}: {
  state: SessionLocationState;
  className?: string;
}) {
  const { blocker, needsClaudeLogin, claudeLogin } = state;
  if (!blocker) return null;
  const { login, start, cancel } = claudeLogin;
  const action = "font-medium text-foreground underline underline-offset-4 hover:opacity-80";
  return (
    <p aria-live="polite" className={cn("text-xs text-muted-foreground", className)}>
      {needsClaudeLogin && login.state === "waiting" ? (
        <>
          Approve the login in your browser…{" "}
          <button type="button" onClick={cancel} className={action}>
            Cancel
          </button>
        </>
      ) : needsClaudeLogin ? (
        <>
          {login.state === "error" ? login.message : blocker}{" "}
          <button type="button" onClick={() => void start()} className={action}>
            {login.state === "error" ? "Try again" : "Log in"}
          </button>
        </>
      ) : (
        blocker
      )}
    </p>
  );
}

function LocationOption({
  selected,
  disabled,
  onSelect,
  icon,
  label,
  title,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
