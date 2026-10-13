"use client";

import { Bot, Check, ChevronDown, Cloud, Folder, FolderGit2, FolderOpen, Laptop } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RepositorySelect } from "@/components/repository-select";
import { Spinner } from "@/components/ui/loaders";
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
/**
 * What a session on this Mac works in: a repository from the user's GitHub,
 * cloned into ~/outrunner/repos (or the clone made before), or, from the
 * menu's last row, any folder on this Mac.
 */
export function LocalRepositoryButton({
  state,
  disabled,
  className,
}: {
  state: SessionLocationState;
  disabled?: boolean;
  className?: string;
}) {
  const { folder, chooseFolder, chooseRepository } = state;
  const chosen = folder.state === "ok" ? folder.folder : null;
  const cloning = folder.state === "cloning" ? folder.repo : null;
  const icon = cloning ? (
    <Spinner label="Cloning" className="size-4 shrink-0" />
  ) : chosen?.git === false ? (
    <Folder className="size-4 shrink-0" />
  ) : (
    <FolderGit2 className="size-4 shrink-0" />
  );
  return (
    <RepositorySelect
      disabled={disabled || cloning !== null}
      triggerClassName={className}
      onPick={(repo) => void chooseRepository(repo.fullName)}
      label={{
        text: cloning ? `Cloning ${cloning.split("/")[1] ?? cloning}…` : chosen ? chosen.name : "Choose repository…",
        title: chosen ? `${chosen.path}\nClick to choose another` : "A repository from GitHub, or a folder on this Mac",
        icon,
      }}
      extra={{
        label: "Choose a folder on this Mac…",
        icon: <FolderOpen className="size-4" />,
        onClick: () => void chooseFolder(),
      }}
    />
  );
}

/** The agent a This Mac session runs: Claude Code, or Codex. */
export function LocalAgentMenu({
  state,
  disabled,
  className,
}: {
  state: SessionLocationState;
  disabled?: boolean;
  className?: string;
}) {
  const { agent, setAgent, codexSupported } = state;
  const label = agent === "codex" ? "Codex" : "Claude Code";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Agent: ${label}. Change the agent`}
          title="The agent that runs the session"
          className={className}
        >
          <Bot className="size-4 shrink-0" />
          {label}
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64">
        <DropdownMenuItem onSelect={() => setAgent("claude")} className="items-start">
          <span className="min-w-0 flex-1">
            <span className="block">Claude Code</span>
            <span className="block text-xs text-muted-foreground">Anthropic&apos;s agent, on your Claude login</span>
          </span>
          <Check className={cn("mt-0.5", agent === "claude" ? "opacity-100" : "opacity-0")} />
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!codexSupported} onSelect={() => setAgent("codex")} className="items-start">
          <span className="min-w-0 flex-1">
            <span className="block">Codex</span>
            <span className="block text-xs text-muted-foreground">
              {codexSupported ? "OpenAI's agent, on your ChatGPT login" : "Update the Outrunner app to use it"}
            </span>
          </span>
          <Check className={cn("mt-0.5", agent === "codex" ? "opacity-100" : "opacity-0")} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Why a local session cannot start yet. When the reason is Claude Code not
 * being logged in on this Mac, it offers the login right there: the app opens
 * the browser, and the note clears once the user approves. While the app sets
 * up its own Claude Code it shows how far that has got, and a failed one can
 * be tried again.
 */
export function LocalBlocker({
  state,
  className,
}: {
  state: SessionLocationState;
  className?: string;
}) {
  const { blocker, needsClaudeLogin, needsCodexLogin, outrunnerModel, claudeLogin, codexLogin, claudeSetup } = state;
  if (!blocker && !outrunnerModel) return null;
  const { login, start, cancel } = needsCodexLogin ? codexLogin : claudeLogin;
  const needsLogin = needsClaudeLogin || needsCodexLogin;
  const action = "font-medium text-foreground underline underline-offset-4 hover:opacity-80";
  return (
    <p aria-live="polite" className={cn("text-xs text-muted-foreground", className)}>
      {(needsLogin || (outrunnerModel && !blocker)) && login.state === "waiting" ? (
        <>
          Approve the login in your browser…{" "}
          <button type="button" onClick={cancel} className={action}>
            Cancel
          </button>
        </>
      ) : needsLogin ? (
        <>
          {login.state === "error" ? login.message : blocker}{" "}
          <button type="button" onClick={() => void start()} className={action}>
            {login.state === "error" ? "Try again" : "Log in"}
          </button>
        </>
      ) : !blocker ? (
        // Not logged in, and the server runs Outrunner's models: not a
        // blocker, but say so, and offer the login that switches back.
        <>
          {login.state === "error"
            ? login.message
            : "Runs on Outrunner's model, since Claude Code isn't logged in on this Mac."}{" "}
          <button type="button" onClick={() => void start()} className={action}>
            {login.state === "error" ? "Try again" : "Log in to use your Claude"}
          </button>
        </>
      ) : claudeSetup.failed ? (
        <>
          {blocker}{" "}
          <button type="button" onClick={() => void claudeSetup.retry()} className={action}>
            Try again
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
