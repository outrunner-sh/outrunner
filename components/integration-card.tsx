import Link from "next/link";
import { Plus, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * One service on Settings → Org → Integrations: its mark and name; when
 * connected, a green dot and what it's connected to, else what it does; and
 * Configure, or Install (an app) or Connect (credentials pasted in).
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
  const icon2 = action?.kind === "configure" ? <Settings /> : <Plus />;
  return (
    <div className="flex items-center gap-3 border-border/60 p-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 [&_svg]:size-6">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{name}</p>
        {connected ? (
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-label="Connected" />
            {connected}
          </p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action &&
        (action.external ? (
          <Button asChild size="sm" variant="outline">
            <a href={action.href}>
              {icon2}
              {label}
            </a>
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href={action.href}>
              {icon2}
              {label}
            </Link>
          </Button>
        ))}
    </div>
  );
}
