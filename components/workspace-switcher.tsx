"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Loader2, Plus, Settings, Users } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { teamRequest } from "@/lib/teams/client";
import { ROLE_LABEL, type Team } from "@/lib/teams/roles";

/**
 * Which workspace the app shows, at the top of the sidebar: switch to another
 * of yours, make a new one, or open this one's settings. Switching goes home,
 * since the page open may be a session of the workspace being left.
 */
export function WorkspaceSwitcher({ team, teams }: { team: Team; teams: Team[] }) {
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTo = async (id: string) => {
    if (id === team.id) return;
    setSwitching(id);
    setError(null);
    try {
      await teamRequest("POST", "/api/teams/current", { teamId: id });
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            aria-label={`Workspace: ${team.name}. Switch workspace`}
          >
            <span className="grid size-5 shrink-0 place-items-center rounded bg-accent text-[11px] font-semibold uppercase text-foreground">
              {team.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{team.name}</span>
            {switching ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspaces</DropdownMenuLabel>
          {teams.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => void switchTo(t.id)}>
              <Check className={t.id === team.id ? "opacity-100" : "opacity-0"} />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.personal ? "Just you" : ROLE_LABEL[t.role]}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus /> New workspace
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings/workspace">
              {team.personal ? <Settings /> : <Users />} Workspace settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <p className="px-2 text-xs text-destructive">{error}</p>}
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** Name a new workspace you'll own; the app switches to it. */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await teamRequest("POST", "/api/teams", { name });
      onOpenChange(false);
      setName("");
      router.push("/settings/workspace");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription>
          A place to share projects and sessions with your team. You&apos;ll own it, and can invite people next.
        </DialogDescription>
        <form onSubmit={create} className="space-y-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme engineering"
            maxLength={80}
            aria-label="Workspace name"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" />} Create workspace
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
