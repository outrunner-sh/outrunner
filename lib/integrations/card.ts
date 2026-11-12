/**
 * What a deployment-wide integration's card on Settings → Org → Integrations offers: GitHub,
 * Slack, Linear and Jira each need an app registered for the deployment before anyone can
 * install them. A card with nothing to do says why, rather than staying blank.
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
}): { action: IntegrationAction; note: string | null } {
  if (input.connected) return { action: { kind: "configure", href: input.configureHref }, note: null };
  // The settings pages say how to add one, for whoever runs the deployment.
  if (!input.installHref) return { action: null, note: "Not available on this deployment yet." };
  if (input.admin || input.installableByMembers === true) {
    return { action: { kind: "install", href: input.installHref, ...(input.external && { external: true }) }, note: null };
  }
  return { action: null, note: "Ask an admin to connect it." };
}
