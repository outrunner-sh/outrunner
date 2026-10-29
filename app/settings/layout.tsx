import { SettingsNav } from "@/components/settings-nav";

/** Two-pane settings: a section nav on the left, the selected section on the
 *  right. It reads nothing, so it shows at once. Owner-gated like the rest of
 *  the control plane: signed out by the proxy, and each section that shows
 *  anything of the user's checks for the owner as it loads — with getOwnerSafe,
 *  so a deployment whose Supabase isn't configured yet still reaches sign-in
 *  rather than the error page. */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden bg-background sm:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]">
      <SettingsNav />
      <main className="min-h-0 overflow-y-auto px-10 py-10">
        <div className="mx-auto max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
