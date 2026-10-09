"use client";

import { Check, ChevronDown, Cloud, Folder, FolderGit2, Laptop } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionLocation, SessionLocationState } from "@/hooks/use-session-location";
import { cn } from "@/lib/utils";

/**
 * Cloud or This Mac, as a menu behind the current choice. This Mac is offered
 * in the Outrunner Mac app only, the one place that can run the agent on the
 * user's machine; elsewhere it is listed, disabled, so the option is
 * discoverable. On this Mac a dot says whether the agent here can run Claude
 * (green) or needs something first (amber; LocalBlocker says what).
 */
export function SessionLocationMenu({
  state,
  disabled,
  className,
}: {
  state: SessionLocationState;
  disabled?: boolean;
  className?: string;
}) {
  const { location, setLocation, runtime, needsClaudeLogin } = state;
  const localPossible = runtime.state === "ready";
  const local = location === "local";
  const healthy = runtime.state === "ready" && runtime.missing.length === 0 && !needsClaudeLogin;
  const label = local ? "This Mac" : "Cloud";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Runs on: ${label}. Change where the session runs`}
          title="Where the session runs"
          className={className}
        >
          {local ? <Laptop className="size-4 shrink-0" /> : <Cloud className="size-4 shrink-0" />}
          {label}
          {local && (
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", healthy ? "bg-positive" : "bg-warning")}
            />
          )}
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64">
        <LocationItem
          value="cloud"
          current={location}
          onSelect={setLocation}
          icon={<Cloud />}
          label="Cloud"
          detail="A Runtime Computer, on one of your GitHub repositories"
        />
        <LocationItem
          value="local"
          current={location}
          onSelect={setLocation}
          disabled={!localPossible}
          icon={<Laptop />}
          label="This Mac"
          detail={localPossible ? "Claude Code on this Mac, in any folder" : "In the Outrunner Mac app only"}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The folder a local session works in — in local mode it stands where the
 * repository picker does. Whether it gets a worktree (a git folder) or is
 * worked on directly is shown beside it, before anything starts.
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
      className={className}
    >
      {chosen?.git === false ? (
        <Folder className="size-4 shrink-0" />
      ) : (
        <FolderGit2 className="size-4 shrink-0" />
      )}
      <span className="truncate">{chosen ? chosen.name : "Choose folder…"}</span>
      <ChevronDown className="size-3.5 shrink-0 opacity-60" />
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

function LocationItem({
  value,
  current,
  onSelect,
  disabled,
  icon,
  label,
  detail,
}: {
  value: SessionLocation;
  current: SessionLocation;
  onSelect: (location: SessionLocation) => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={() => onSelect(value)} className="items-start">
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
      <Check className={cn("mt-0.5", value === current ? "opacity-100" : "opacity-0")} />
    </DropdownMenuItem>
  );
}
