"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, BarChart3, Blocks, Box, Brain, Building2, Code, CreditCard, Gauge, Info, KeyRound, Layers, Lightbulb, Plug, ScrollText, ShieldCheck, SlidersHorizontal, User, Users, X } from "lucide-react";

import { SIDEBAR_ROW } from "@/components/ui/sidebar-row";
import { PROVIDERS_SETTINGS_HREF, USAGE_SETTINGS_HREF } from "@/lib/settings-links";
import { cn } from "@/lib/utils";

const groups = [
  {
    label: "Account",
    sections: [
      { href: "/settings/general", label: "General", icon: Info },
      { href: "/settings/account", label: "Account", icon: User },
      // The user's plan; Stripe sends them back here after Checkout or the portal.
      { href: "/settings/billing", label: "Billing", icon: CreditCard },
      // What Outrunner's models and the user's own keys have used; the sidebar's
      // allowance bar points here.
      { href: USAGE_SETTINGS_HREF, label: "Usage", icon: BarChart3 },
      // Where triage captures come from: Slack, and the CLI.
      // Your own Slack account, connected to an org.
      { href: "/settings/integrations", label: "Connections", icon: Plug },
      // Keys for the public API that act as the user (docs/api.md).
      { href: "/settings/api-keys", label: "API keys", icon: Code },
    ],
  },
  {
    label: "Org",
    sections: [
      // The org the app is showing (the sidebar's switcher picks it).
      { href: "/settings/org", label: "General", icon: Building2 },
      // Who's in it; its admins invite, answer requests and remove.
      { href: "/settings/org/members", label: "Members", icon: Users },
      // What Everyone and each role may do with its projects; admins'.
      { href: "/settings/org/access", label: "Roles & access", icon: ShieldCheck },
      // The Outrunner GitHub App's installations; admins install it.
      { href: "/settings/org/integrations", label: "Integrations", icon: Blocks },
      // Keys the org's members' cloud sessions run on; admins save them.
      { href: "/settings/org/keys", label: "Keys", icon: KeyRound },
      // Keys for the public API, for the org; admins make them. Apart from
      // Keys above, which are model providers'.
      { href: "/settings/org/api-keys", label: "API keys", icon: Code },
      // Model and box size for members who haven't chosen; admins set them.
      { href: "/settings/org/defaults", label: "Defaults", icon: SlidersHorizontal },
      // The org's cloud hours, and its admins' limit and alerts on them.
      { href: "/settings/org/usage", label: "Usage", icon: Gauge },
      // Every change to the org, by whom and when; admins'.
      { href: "/settings/org/audit", label: "Audit log", icon: ScrollText },
    ],
  },
  {
    label: "Agents",
    sections: [
      // The user's own Claude subscription and keys for model providers
      // (lib/settings-links.ts): a failed workspace create points here when it
      // has no Claude.
      { href: PROVIDERS_SETTINGS_HREF, label: "Providers (BYOK)", icon: KeyRound },
      // The models the chat picker shows first, and the one new sessions start on.
      { href: "/settings/models", label: "Default models", icon: Layers },
      // Standing instructions every new session loads: the org's and the user's
      // own, and what agents suggest adding to them.
      { href: "/settings/learnings", label: "Learnings", icon: Lightbulb },
      // What agents noted to remember across sessions, to read and delete.
      { href: "/settings/memory", label: "Memory", icon: Brain },
      // Where cloud sessions run; a create that needs a Daytona key points here.
      { href: "/settings/sandbox", label: "Sandbox", icon: Box },
    ],
  },
];

export function settingsNavigationTitle(pathname: string): string {
  return groups.flatMap((group) => group.sections).find((section) => section.href === pathname)?.label
    ?? (pathname.endsWith("/github") ? "GitHub" : pathname.endsWith("/slack") ? "Slack" : "Settings");
}

/** The settings-nav column, laid out as the app sidebar is (same width, rows
 *  and header): Back to app, then the sections in groups, the active one
 *  highlighted. */
export function SettingsNav({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  return (
    <aside
      role="navigation"
      aria-label="Settings"
      className="flex h-full min-h-0 flex-col gap-7 overflow-y-auto border-r border-border/60 bg-sidebar px-3 pb-6 pt-4"
    >
      <div className="flex items-center justify-between gap-2">
        <Link href="/" className={cn(SIDEBAR_ROW, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <ArrowLeft /> Back to app
        </Link>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close settings menu" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden">
            <X className="size-4" />
          </button>
        )}
      </div>
      {groups.map((group) => (
        <div key={group.label} className="space-y-0.5">
          <h2 className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">{group.label}</h2>
          {group.sections.map(({ href, label, icon: Icon }) => {
            // Integrations stays lit on the pages its cards open.
            const active =
              pathname === href ||
              (href === "/settings/org/integrations" && (pathname === "/settings/org/github" || pathname === "/settings/org/slack"));
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  SIDEBAR_ROW,
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon /> {label}
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
