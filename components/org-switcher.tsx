"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus, Settings, Terminal, Users } from "lucide-react";
import { useEffect, useState } from "react";

import { CreateOrgDialog } from "@/components/create-org-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/loaders";
import { refreshMissions } from "@/hooks/use-missions";
import { clearKeptPages } from "@/lib/client/kept-page";
import { clearDrafts } from "@/lib/client/drafts";
import { requestJson } from "@/lib/http/request-json";
import { clearMissions } from "@/lib/missions/kept-missions";
import { type Org, orgSummary } from "@/lib/orgs/active";
import { clearAppDataCache } from "@/lib/session/app-data-cache";
import { clearKeptTriage } from "@/lib/triage/kept-triage";

/**
 * The org the sidebar lists, as its header: Outrunner's mark and the org's
 * name, opening onto where it's set up (settings, members) and the user's
 * other orgs to switch to, or a new team org. Not billing: a plan is the
 * account's, not an org's (Settings → Billing). Switching goes home, since
 * the session open may be in the org left behind.
 */
export function OrgSwitcher({ orgs, activeOrgId }: { orgs: Org[]; activeOrgId: string | null }) {
  const router = useRouter();
  const active = orgs.find((o) => o.id === activeOrgId) ?? orgs[0];
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // It floats over the nav, so it doesn't stay: gone after a while, on a
  // click, or as the menu opens again.
  useEffect(() => {
    if (!error) return;
    const clear = setTimeout(() => setError(null), ERROR_SHOWN_MS);
    return () => clearTimeout(clear);
  }, [error]);
  const [creating, setCreating] = useState(false);

  const show = async (org: Org) => {
    if (org.id === active?.id) return;
    setSwitching(org.id);
    setError(null);
    try {
      await requestJson("/api/orgs/active", {
        method: "POST",
        body: { orgId: org.id },
        fallback: "Couldn't switch orgs. Try again.",
      });
      // The lists kept are the org left behind: none of it shows in the new one
      // (the Runners and Triage panes seed from them), nor do the drafts typed
      // there. The Runners are looked at again here, since the sidebar stays
      // put across the switch.
      clearAppDataCache();
      clearMissions();
      clearKeptTriage();
      clearKeptPages();
      clearDrafts();
      void refreshMissions();
      router.push("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't switch orgs. Try again.");
    } finally {
      setSwitching(null);
    }
  };

  if (!active) return null;
  return (
    <div className="relative min-w-0 flex-1">
      <DropdownMenu onOpenChange={(open) => open && setError(null)}>
        <DropdownMenuTrigger
          className="-ml-1 flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
          aria-label={`Org: ${active.name}. Switch org`}
          title={active.name}
        >
          {switching ? <Spinner /> : <OrgMark size="sm" />}
          <span className="min-w-0 truncate">{active.name}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <div className="flex items-center gap-3 px-2 py-2">
            <OrgMark size="lg" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{active.name}</p>
              <p className="text-xs text-muted-foreground">{orgSummary(active)}</p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/settings/org">
              <Settings className="size-4" /> Organization settings
            </Link>
          </DropdownMenuItem>
          {/* A personal org is the user alone. */}
          {!active.personal && (
            <DropdownMenuItem asChild className="gap-2">
              <Link href="/settings/org/members">
                <Users className="size-4" /> Members
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch organization</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuItem key={org.id} onSelect={() => void show(org)} className="gap-2">
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {/* Names are free text: which is the user's own, and where
                  they're an admin, tells two alike apart. */}
              {org.personal || org.role === "admin" ? (
                <span className="text-xs text-muted-foreground">{org.personal ? "Personal" : "Admin"}</span>
              ) : null}
              {org.id === active.id ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-2 text-muted-foreground">
            <Plus className="size-4" /> New team org
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Under the header, not in its row: the row stays as it is. */}
      {error ? (
        // The live region on its own, so the button is still read as one.
        <div role="alert" className="absolute left-0 top-full z-10 mt-1 w-56">
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label={`${error} (dismiss)`}
            title="Dismiss"
            className="w-full rounded-md border border-border bg-popover px-2 py-1.5 text-left text-xs text-destructive shadow-md"
          >
            {error}
          </button>
        </div>
      ) : null}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** How long a failed switch's message stays over the nav. */
const ERROR_SHOWN_MS = 6000;

/** The org's mark: Outrunner's, the same for every org. */
function OrgMark({ size }: { size: "sm" | "lg" }) {
  return size === "sm" ? (
    <Terminal aria-hidden className="size-4 shrink-0" />
  ) : (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent">
      <Terminal className="size-4" />
    </span>
  );
}
