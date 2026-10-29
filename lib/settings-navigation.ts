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
  ["/settings/sandbox", "/settings/profile"],
] as const;

export const PERSONAL_SETTINGS = [
  ["profile", "Profile"],
  ["preferences", "Preferences"],
  ["coding-agents", "Coding agents"],
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
