"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, ChevronLeft, CreditCard, Info, KeyRound, User } from "lucide-react";

import { PROVIDERS_SETTINGS_HREF } from "@/lib/settings-links";
import { cn } from "@/lib/utils";

const sections = [
  { href: "/settings/general", label: "General", icon: Info },
  { href: "/settings/account", label: "Account", icon: User },
  // The user's plan; Stripe sends them back here after Checkout or the portal.
  { href: "/settings/billing", label: "Billing", icon: CreditCard },
  // Where cloud sessions run; a create that needs a Daytona key points here.
  { href: "/settings/sandbox", label: "Sandbox", icon: Box },
  // The user's own Claude subscription and keys for model providers
  // (lib/settings-links.ts): a failed workspace create points here when it
  // has no Claude.
  { href: PROVIDERS_SETTINGS_HREF, label: "Providers (BYOK)", icon: KeyRound },
];

/** The settings-nav column: a Back link home, then the section links with the
 *  active one highlighted (Computer-style two-pane settings). */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <aside
      role="navigation"
      aria-label="Settings"
      className="flex min-h-0 flex-col gap-0.5 border-r border-border/60 px-4 py-6"
    >
      <Link
        href="/"
        className="mb-3 flex items-center gap-1.5 px-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> Back
      </Link>
      {sections.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
          </Link>
        );
      })}
    </aside>
  );
}
