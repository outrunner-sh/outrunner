import { Code2, FlaskConical, PackageOpen } from "lucide-react";

import type { LineDelta, LineCounts, LineKind } from "@/lib/review/line-kinds";
import { cn } from "@/lib/utils";

const KIND = {
  code: { label: "Code", Icon: Code2, tint: "text-muted-foreground" },
  test: { label: "Tests", Icon: FlaskConical, tint: "text-muted-foreground" },
  generated: { label: "Generated", Icon: PackageOpen, tint: "text-muted-foreground" },
} satisfies Record<LineKind, { label: string; Icon: typeof Code2; tint: string }>;

export const kindLabel = (kind: LineKind) => KIND[kind].label;

/** What kind of file it is, as an icon: code, a test, or generated. */
export function KindIcon({ kind, className }: { kind: LineKind; className?: string }) {
  const { label, Icon, tint } = KIND[kind];
  return <Icon className={cn("size-3.5 shrink-0", tint, className)} aria-label={label} />;
}

/** `+12 −3`, green and red, or a dash for none. Generated lines are dimmed:
 *  they are there to be skimmed, not read. */
export function Delta({ delta, dim = false, className }: { delta: LineDelta; dim?: boolean; className?: string }) {
  if (delta.additions === 0 && delta.deletions === 0) return <span className={cn("text-muted-foreground/50", className)}>–</span>;
  return (
    <span className={cn("tabular-nums", dim && "opacity-60", className)}>
      <span className="text-emerald-500">+{delta.additions}</span> <span className="text-red-400">−{delta.deletions}</span>
    </span>
  );
}

/** A PR's lines by kind, each with its icon: what there is to read, apart
 *  from what a tool wrote. */
export function LineCountsSummary({ counts }: { counts: LineCounts }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      {(["code", "test", "generated"] as const).map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1" title={`${kindLabel(kind)} lines`}>
          <KindIcon kind={kind} />
          <Delta delta={counts[kind]} dim={kind === "generated"} />
        </span>
      ))}
    </span>
  );
}
