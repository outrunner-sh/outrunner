import { ExternalLink } from "lucide-react";

import { cn } from "@/lib/utils";

/** A panel's section title, with an optional link on the right (where to get
 *  a key, say). */
export function SectionHeader({ title, link }: { title: string; link?: { href: string; label: string } }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
      {link ? (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {link.label} <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

/** A dot and a word: whether this is connected. */
export function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span aria-hidden className={cn("size-1.5 rounded-full", connected ? "bg-positive" : "bg-muted-foreground/50")} />
      <span className={connected ? "text-foreground" : "text-muted-foreground"}>
        {connected ? "Connected" : "Not connected"}
      </span>
    </div>
  );
}

/** A bordered table of terms and their values, one {@link DetailRow} each. */
export function Details({ children }: { children: React.ReactNode }) {
  return (
    <dl className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 text-[13px]">{children}</dl>
  );
}

/** A row of {@link Details}: a muted term beside its value, dimmed a little
 *  less. */
export function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr]">
      <dt className="bg-muted/30 px-3 py-2 text-muted-foreground">{term}</dt>
      <dd className="px-3 py-2 text-foreground/75">{children}</dd>
    </div>
  );
}
