"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, CreditCard, Plus, Settings, Terminal, Users } from "lucide-react";
import { useState } from "react";

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
import { type Org, orgSummary } from "@/lib/orgs/active";
import { requestJson } from "@/lib/http/request-json";

/**
 * The org the sidebar lists, as its header: Outrunner's mark and the org's
 * name, opening onto
 * where it's set up (settings, billing, members) and the user's other orgs to
 * switch to, or a new team org. Switching goes home, since the session open
 * may be in the org left behind.
 */
export function OrgSwitcher({ orgs, activeOrgId }: { orgs: Org[]; activeOrgId: string | null }) {
  const router = useRouter();
  const active = orgs.find((o) => o.id === activeOrgId) ?? orgs[0];
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    <div className="min-w-0 flex-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="-ml-1 flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
          aria-label={`Org: ${active.name}. Switch org`}
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
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/settings/billing">
              <CreditCard className="size-4" /> Billing
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
              {org.id === active.id ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-2 text-muted-foreground">
            <Plus className="size-4" /> New team org
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="pt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

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
