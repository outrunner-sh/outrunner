"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, BarChart3, Box, Building2, CreditCard, Info, KeyRound, Layers, ShieldCheck, Terminal, User, Users } from "lucide-react";

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
      // Where cloud sessions run; a create that needs a Daytona key points here.
      { href: "/settings/sandbox", label: "Sandbox", icon: Box },
    ],
  },
];

/** The settings-nav column, laid out as the app sidebar is (same width, rows
 *  and header): Back to app, then the sections in groups, the active one
 *  highlighted. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <aside
      role="navigation"
      aria-label="Settings"
      className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border/60 bg-sidebar px-3 pb-3 pt-5"
    >
      <Link href="/" className="flex items-center gap-2 px-2 font-mono text-sm font-semibold text-foreground">
        <Terminal className="size-4" />
        outrunner
      </Link>
      <Link href="/" className={cn(SIDEBAR_ROW, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
        <ArrowLeft /> Back to app
      </Link>
      {groups.map((group) => (
        <div key={group.label} className="space-y-0.5">
          <h2 className="px-2 pb-1 text-[13px] text-muted-foreground">{group.label}</h2>
          {group.sections.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
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
