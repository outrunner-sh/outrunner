import { SettingsFrame } from "@/components/settings-frame";

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
  return <SettingsFrame>{children}</SettingsFrame>;
}
