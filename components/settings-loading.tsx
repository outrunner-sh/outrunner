import { SkeletonRows } from "@/components/ui/skeleton-swap";

/** A settings section while its data streams in: its heading, where the
 *  section's own puts it, then placeholder rows. */
export function SettingsLoading({ title }: { title: string }) {
  return (
    <section className="space-y-6" aria-busy>
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      <SkeletonRows rows={5} rowHeight={36} />
    </section>
  );
}
