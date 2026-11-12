/**
 * What a deployment-wide integration's card on Settings → Org → Integrations offers: GitHub,
 * Slack, Linear and Jira each need an app registered for the deployment before anyone can
 * install them. Without one, an admin would otherwise see a card with nothing on it and no
 * reason why.
 */

export type IntegrationAction = { kind: "configure" | "install" | "connect"; href: string; external?: boolean } | null;

export function deploymentCard(input: {
  /** Connected to something already: configured from its page, whatever else is true. */
  connected: boolean;
  admin: boolean;
  configureHref: string;
  /** Where installing starts; null when this deployment has no app for it. */
  installHref: string | null;
  /** Whether installing leaves the app (a GitHub or Slack sign-in). */
  external?: boolean;
  /** Who can install: an admin, unless the service decides itself (Slack). */
  installableByMembers?: boolean;
  /** Where the deployment's setup is written down. */
  setupDoc: string;
}): { action: IntegrationAction; note: string | null } {
  if (input.connected) return { action: { kind: "configure", href: input.configureHref }, note: null };
  const may = input.admin || input.installableByMembers === true;
  if (input.installHref && may) return { action: { kind: "install", href: input.installHref, ...(input.external && { external: true }) }, note: null };
  if (!input.installHref && input.admin) return { action: null, note: `Not set up on this deployment yet: its app has to be added first (${input.setupDoc}).` };
  return { action: null, note: null };
}
