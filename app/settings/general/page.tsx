import { PageHeader } from "@/components/page-layout";

/** General: what the app is. Kept to real, static facts — no faked toggles. */
export default function GeneralSettings() {
  return (
    <section className="space-y-6">
      <PageHeader title={"General"} />

      <div className="space-y-1">
        <span className="text-lg font-semibold text-foreground">Outrunner</span>
        <p className="text-sm text-muted-foreground">Cloud sessions for Claude Code, Codex and open models.</p>
      </div>

      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        Spin up an isolated cloud workspace per task — each on its own git branch —
        running Claude Code or Codex, chat with it live, and review every change it makes.
      </p>
    </section>
  );
}
