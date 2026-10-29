import Link from "next/link";
import { Check, ChevronRight } from "lucide-react";

import { DashedFrame } from "@/components/ui/dashed-frame";
import { cn } from "@/lib/utils";

/**
 * One service on Settings → Org → Integrations, in the same dashed frame as
 * onboarding's agent cards. The whole card opens its destination; a service
 * with no available action stays informational.
 */
export function IntegrationCard({
  icon,
  name,
  description,
  connected,
  action,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  /** What it's connected to (an account, a Slack workspace); null when it isn't. */
  connected: string | null;
  /** Configure (connected), or Install or Connect; none for someone who can't. */
  action: { kind: "configure" | "install" | "connect"; href: string; external?: boolean } | null;
}) {
  const label = action?.kind === "configure" ? "Configure" : action?.kind === "connect" ? "Connect" : "Install";
  const className = cn(
    "relative flex min-h-48 min-w-0 flex-col rounded-xl p-5 text-left",
    action && "group transition-colors hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
  );
  const content = (
    <>
      <DashedFrame />
      <span className="flex items-start justify-between gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30 [&_svg]:size-6">
          {icon}
        </span>
        {connected && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-amber-500">
            <Check aria-hidden className="size-3" strokeWidth={3} /> Connected
          </span>
        )}
      </span>
      <span className="mt-5 block space-y-1">
        <span className="block text-base font-medium text-foreground">{name}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{description}</span>
        {connected && <span className="block break-words text-xs text-muted-foreground">{connected}</span>}
      </span>
      {action && (
        <span className="mt-auto flex items-center gap-1.5 pt-4 text-xs text-muted-foreground group-hover:text-foreground">
          {label}
          <ChevronRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      )}
    </>
  );

  if (!action) return <div className={className}>{content}</div>;

  const CardLink = action.external ? "a" : Link;
  return (
    <CardLink href={action.href} aria-label={`${label} ${name}`} className={className}>
      {content}
    </CardLink>
  );
}
