import Link from "next/link";

import { ChecksDot } from "@/components/review/checks-dot";
import { Delta, KindIcon, kindLabel } from "@/components/review/line-counts";
import type { PullSummary } from "@/lib/review/pulls";

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

const KINDS = ["code", "test", "generated"] as const;

/** The Review inbox: one line per pull request, dense enough to scan dozens,
 *  with its lines by kind in columns of their own. */
export function PullTable({ pulls }: { pulls: PullSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-[12px]">
        <thead className="bg-muted/30 text-left text-[11px] text-muted-foreground">
          <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-normal">
            <th className="w-6" aria-label="Checks" />
            <th>Pull request</th>
            <th>Repository</th>
            <th>Author</th>
            {KINDS.map((kind) => (
              <th key={kind} className="text-right" title={`${kindLabel(kind)} lines`}>
                <span className="inline-flex items-center gap-1">
                  <KindIcon kind={kind} />
                  {kindLabel(kind)}
                </span>
              </th>
            ))}
            <th>Outrunner</th>
            <th className="text-right">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {pulls.map((p) => (
            <PullRow key={`${p.repo}#${p.number}`} pull={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** One pull request, a line of the table: the whole row opens it. */
function PullRow({ pull: p }: { pull: PullSummary }) {
  const href = `/review/${p.repo}/${p.number}`;
  // Each cell links, rather than the row, as a table row can't be a link.
  const cell = "block px-2 py-1.5";
  return (
    <tr className="transition-colors hover:bg-accent/60">
      <td>
        <Link href={href} className={cell} tabIndex={-1}>
          <ChecksDot checks={p.checks} />
        </Link>
      </td>
      <td className="max-w-0 w-[40%]">
        <Link href={href} className={`${cell} truncate text-foreground`}>
          <span className="text-muted-foreground">#{p.number}</span> {p.title}
          {p.draft && <span className="ml-2 rounded border border-border px-1 text-[10px] text-muted-foreground">Draft</span>}
        </Link>
      </td>
      <td className="whitespace-nowrap text-muted-foreground">
        <Link href={href} className={cell} tabIndex={-1}>
          {p.repo.split("/")[1] ?? p.repo}
        </Link>
      </td>
      <td className="whitespace-nowrap text-muted-foreground">
        <Link href={href} className={cell} tabIndex={-1}>
          {p.author ?? "–"}
        </Link>
      </td>
      {KINDS.map((kind) => (
        <td key={kind} className="whitespace-nowrap text-right">
          <Link href={href} className={cell} tabIndex={-1}>
            {p.lines ? <Delta delta={p.lines[kind]} dim={kind === "generated"} /> : <span className="text-muted-foreground/50">…</span>}
          </Link>
        </td>
      ))}
      <td className="whitespace-nowrap text-muted-foreground">
        <Link href={href} className={cell} tabIndex={-1}>
          {p.itemKey ?? (p.sessionId ? "Session" : "–")}
        </Link>
      </td>
      <td className="whitespace-nowrap text-right text-muted-foreground">
        <Link href={href} className={cell} tabIndex={-1}>
          {ago(p.updatedAt)}
        </Link>
      </td>
    </tr>
  );
}
