"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BarChart3,
  Blocks,
  Building2,
  Code,
  CreditCard,
  Cloud,
  Gauge,
  Info,
  Plug,
  ScrollText,
  SlidersHorizontal,
  Terminal,
  User,
  Users,
  X,
} from "lucide-react";

import { SIDEBAR_ROW } from "@/components/ui/sidebar-row";
import { PERSONAL_SETTINGS, ORG_SETTINGS } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";

const icons = [User, SlidersHorizontal, Terminal, Cloud, Plug, BarChart3, Code];
const orgIcons = [
  Building2,
  Users,
  Terminal,
  Blocks,
  Gauge,
  CreditCard,
  Code,
  ScrollText,
];

/** The settings-nav column, laid out as the app sidebar is (same width, rows
 *  and header): Back to app, then the sections in groups, the active one
 *  highlighted. */
export function SettingsNav({
  onClose,
  orgName,
}: {
  onClose?: () => void;
  orgName?: string;
}) {
  const pathname = usePathname();
  const groups = [
    {
      label: "Personal",
      sections: PERSONAL_SETTINGS.map(([path, label], i) => ({
        href: `/settings/${path}`,
        label,
        icon: icons[i],
      })),
    },
    {
      label: orgName ? `Organization · ${orgName}` : "Organization",
      sections: ORG_SETTINGS.map(([path, label], i) => ({
        href: `/settings/org${path}`,
        label,
        icon: orgIcons[i],
      })),
    },
  ];
  return (
    <aside
      role="navigation"
      aria-label="Settings"
      className="flex h-full min-h-0 flex-col gap-7 overflow-y-auto border-r border-border/60 bg-sidebar px-3 pb-6 pt-4"
    >
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/"
          className={cn(SIDEBAR_ROW, "text-muted-foreground hover:bg-accent hover:text-foreground")}
        >
          <ArrowLeft /> Back to app
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings menu"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {groups.map((group) => (
        <div key={group.label} className="space-y-0.5">
          <h2 className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">
            {group.label}
          </h2>
          {group.sections.map(({ href, label, icon: Icon }) => {
            // Integrations stays lit on the pages its cards open.
            const active =
              pathname === href ||
              (href === "/settings/org/integrations" &&
                (pathname === "/settings/org/github" ||
                  pathname === "/settings/org/slack" ||
                  pathname === "/settings/org/linear" ||
                  pathname.startsWith("/settings/org/integrations/")));
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  SIDEBAR_ROW,
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon /> {label}
              </Link>
            );
          })}
        </div>
      ))}
      <Link
        href="/help/about"
        className={cn(
          SIDEBAR_ROW,
          "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Info /> Help / About
      </Link>
    </aside>
  );
}
