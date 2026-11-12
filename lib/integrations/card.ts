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

type Card = ReturnType<typeof deploymentCard>;

/**
 * The four deployment-wide cards, from what this deployment has apps for and what the org has
 * connected: the Integrations page's wiring, apart from its loaders.
 */
export function deploymentCards(input: {
  admin: boolean;
  /** This deployment's apps: whether each is set up, or Slack's install link. */
  apps: { github: boolean; slackInstallUrl: string | null; linear: boolean; jira: boolean };
  /** What the org has connected of each. */
  connected: { github: boolean; slack: boolean; linear: boolean; jira: boolean };
}): { github: Card; slack: Card; linear: Card; jira: Card } {
  const { admin, apps, connected } = input;
  return {
    github: deploymentCard({ connected: connected.github, admin, configureHref: "/settings/org/github", installHref: apps.github ? "/api/github/app/install" : null, external: true }),
    slack: deploymentCard({ connected: connected.slack, admin, configureHref: "/settings/org/slack", installHref: apps.slackInstallUrl, external: true, installableByMembers: true }),
    linear: deploymentCard({ connected: connected.linear, admin, configureHref: "/settings/org/linear", installHref: apps.linear ? "/settings/org/linear" : null }),
    jira: deploymentCard({ connected: connected.jira, admin, configureHref: "/settings/org/jira", installHref: apps.jira ? "/settings/org/jira" : null }),
  };
}
