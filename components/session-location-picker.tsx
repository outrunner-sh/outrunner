"use client";

import { Cloud, FolderGit2, Laptop } from "lucide-react";

import type { SessionLocationState } from "@/hooks/use-session-location";
import { cn } from "@/lib/utils";

/**
 * Cloud or This Mac, and for This Mac which clone the session branches from.
 * Local is offered only inside the Outrunner Mac app, the one place that can
 * run the agent on the user's machine; elsewhere it is shown, disabled, so the
 * option is discoverable.
 */
export function SessionLocationPicker({
  state,
  disabled,
  className,
}: {
  state: SessionLocationState;
  disabled?: boolean;
  className?: string;
}) {
  const { location, setLocation, runtime, clone, chooseClone } = state;
  const localPossible = runtime.state === "ready";

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs", className)}>
      <div
        role="radiogroup"
        aria-label="Where the session runs"
        className="bg-muted/60 inline-flex rounded-lg p-0.5"
      >
        <LocationOption
          selected={location === "cloud"}
          disabled={disabled}
          onSelect={() => setLocation("cloud")}
          icon={<Cloud className="size-3.5" />}
          label="Cloud"
          title="Run on a cloud Runtime Computer"
        />
        <LocationOption
          selected={location === "local"}
          disabled={disabled || !localPossible}
          onSelect={() => setLocation("local")}
          icon={<Laptop className="size-3.5" />}
          label="This Mac"
          title={
            localPossible
              ? "Run Claude Code on this Mac, in a worktree of your own clone"
              : "Local sessions run in the Outrunner Mac app"
          }
        />
      </div>

      {location === "local" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void chooseClone()}
          title={clone.state === "ok" ? clone.path : "Choose your local clone"}
          className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex max-w-[22rem] items-center gap-1.5 rounded-md px-2 py-1 transition-colors disabled:opacity-50"
        >
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="truncate font-mono">
            {clone.state === "ok" ? shortenHome(clone.path) : "Choose clone…"}
          </span>
        </button>
      )}
    </div>
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

/** `/Users/ada/code/app` → `~/code/app`, which is how people read their paths. */
function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}
