"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * Back to wherever the user came from — a workspace, or home. The Mac app has
 * no browser chrome, so a page with no way out of it needs its own. With no
 * page to return to (opened here directly, e.g. from the tray), it goes home.
 */
export function BackButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}
      className={
        className ??
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      }
    >
      <ArrowLeft className="size-4" />
      Back
    </button>
  );
}
