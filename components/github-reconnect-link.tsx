import Link from "next/link";

import { GITHUB_RECONNECT_HREF } from "@/lib/github/http";
import { cn } from "@/lib/utils";

export { GITHUB_RECONNECT_HREF };

/**
 * Trails a GitHub error the API flagged `reconnect: true`: retrying cannot
 * help, only a fresh sign-in can, so point at where that happens.
 */
export function GitHubReconnectLink({ className }: { className?: string }) {
  return (
    <Link
      href={GITHUB_RECONNECT_HREF}
      className={cn("text-foreground ml-1 font-medium underline underline-offset-2", className)}
    >
      Reconnect in Settings
    </Link>
  );
}
