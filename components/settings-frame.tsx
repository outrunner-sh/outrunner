"use client";

import { ArrowLeft, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { SettingsNav } from "@/components/settings-nav";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useModalPanel } from "@/hooks/use-modal-panel";
import { cn } from "@/lib/utils";

/** Settings keeps its section navigation in a drawer on phones, leaving the
 *  page the full width. The desktop navigation stays beside the page. */
export function SettingsFrame({ children, orgName }: { children: React.ReactNode; orgName?: string }) {
  const pathname = usePathname();
  const wide = useMediaQuery("(min-width: 640px)");
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const open = drawerOn === pathname && !wide;
  // A navigation or a resize closes it for good, including on browser Back.
  if (drawerOn !== null && !open) setDrawerOn(null);
  const close = () => setDrawerOn(null);
  const drawer = useModalPanel(open, close);

  return (
    <div className="grid h-dvh grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background sm:grid-cols-[264px_minmax(0,1fr)] sm:grid-rows-1">
      {open && <div aria-hidden className="fixed inset-0 z-40 bg-black/60 sm:hidden" onClick={close} />}
      <div
        id="settings-navigation"
        ref={drawer}
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
        aria-label={open ? "Settings navigation" : undefined}
        onClickCapture={(event) => {
          if (open && (event.target as Element).closest("a[href]")) close();
        }}
        className={cn(
          "min-h-0 sm:block",
          open ? "fixed inset-y-0 left-0 z-50 w-[min(264px,85vw)] shadow-2xl shadow-black/60" : "hidden",
        )}
      >
        <SettingsNav onClose={close} orgName={orgName} />
      </div>
      <header className="flex h-11 items-center gap-2 border-b border-border/60 px-2 sm:hidden">
        <button
          type="button"
          onClick={() => setDrawerOn(pathname)}
          aria-label="Open settings menu"
          aria-expanded={open}
          aria-controls="settings-navigation"
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Menu className="size-4" />
        </button>
        <span className="text-sm font-medium">Settings</span>
        <Link href="/" className="ml-auto flex items-center gap-1.5 rounded-md p-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Back to app
        </Link>
      </header>
      <main className="min-h-0 min-w-0 overflow-y-auto px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
        <div className="mx-auto max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
