/** Canonical settings locations; redirects retain existing query strings and hashes. */
export const SETTINGS_REDIRECTS = [
  ["/settings", "/settings/profile"],
  ["/settings/account", "/settings/profile"],
  ["/settings/general", "/help/about"],
  ["/settings/claude", "/settings/coding-agents?tab=claude"],
  ["/settings/models", "/settings/preferences"],
  ["/settings/integrations", "/settings/connections"],
  ["/settings/api-keys", "/settings/developer"],
  ["/settings/billing", "/settings/org/billing"],
  ["/settings/org/keys", "/settings/org/coding-agents"],
  ["/settings/org/api-keys", "/settings/org/developer"],
  ["/settings/org/access", "/settings/org/members?tab=roles"],
  ["/settings/org/defaults", "/settings/org"],
] as const;

export const PERSONAL_SETTINGS = [
  ["profile", "Profile"],
  ["preferences", "Preferences"],
  ["coding-agents", "Coding agents"],
  ["sandbox", "Sandbox"],
  ["connections", "Connections"],
  ["usage", "Usage"],
  ["developer", "Developer"],
] as const;
export const ORG_SETTINGS = [
  ["", "General"],
  ["/members", "Members & access"],
  ["/coding-agents", "Coding agents"],
  ["/integrations", "Integrations"],
  ["/usage", "Usage & limits"],
  ["/billing", "Billing"],
  ["/developer", "Developer"],
  ["/audit", "Audit log"],
] as const;

/** Breadcrumb labels follow the same canonical routes as the settings sidebar. */
export function settingsNavigationTitle(pathname: string): string {
  const personal = PERSONAL_SETTINGS.find(([path]) => pathname === `/settings/${path}`);
  if (personal) return personal[1];
  const organization = ORG_SETTINGS.find(([path]) => pathname === `/settings/org${path}`);
  if (organization) return organization[1];
  if (pathname === "/settings/org/github") return "GitHub";
  if (pathname === "/settings/org/slack") return "Slack";
  if (pathname === "/settings/org/linear") return "Linear";
  if (pathname.startsWith("/settings/org/integrations/")) return "Integrations";
  return "Settings";
}
