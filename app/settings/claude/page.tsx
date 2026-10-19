import { redirect } from "next/navigation";

import { providerSettingsHref } from "@/lib/settings-links";

/** Claude moved into Settings → Providers; links and bookmarks to it still
 *  land there. */
export default function ClaudeSettings() {
  redirect(providerSettingsHref("claude"));
}
