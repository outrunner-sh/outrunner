"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Plus, Settings, User } from "lucide-react";
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
import { SIDEBAR_ROW } from "@/components/ui/sidebar-row";
import type { Org } from "@/lib/orgs/active";
import { requestJson } from "@/lib/http/request-json";
import { cn } from "@/lib/utils";

/**
 * The org the sidebar lists, above its nav: pick another to see its projects
 * and your sessions in it, or make a team org. Switching goes home, since the
 * session open may be in the org left behind.
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
    <div className="-my-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(SIDEBAR_ROW, "text-foreground outline-none hover:bg-accent data-[state=open]:bg-accent")}
          aria-label={`Org: ${active.name}`}
        >
          {switching ? <Spinner /> : <OrgIcon org={active} />}
          <span className="min-w-0 flex-1 truncate">{active.name}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Orgs</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuItem key={org.id} onSelect={() => void show(org)} className="gap-2">
              <OrgIcon org={org} />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {org.role === "admin" && !org.personal ? (
                <span className="text-xs text-muted-foreground">Admin</span>
              ) : null}
              {org.id === active.id ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-2">
            <Plus className="size-3.5" /> New team org
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/settings/org">
              <Settings className="size-3.5" /> Org settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="px-2 pt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function OrgIcon({ org }: { org: Org }) {
  return org.personal ? <User className="size-3.5 shrink-0" /> : <Building2 className="size-3.5 shrink-0" />;
}
