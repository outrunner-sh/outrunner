/**
 * What the audit log records (20261101115000_audit_events.sql), and how each
 * reads on Settings → Org → Audit log. Pure, for the page and the tests;
 * lib/audit/record.ts writes them.
 *
 * Details hold what a reader needs to know what changed (a role, a plan, a
 * key's last 4), never a secret.
 */

export type AuditAction =
  | "org.renamed"
  | "member.invited"
  | "invite.revoked"
  | "member.joined"
  | "request.approved"
  | "request.declined"
  | "member.removed"
  | "member.left"
  | "member.role_changed"
  | "member.roles_set"
  | "role.created"
  | "role.renamed"
  | "role.deleted"
  | "access.changed"
  | "key.saved"
  | "key.removed"
  | "api_key.created"
  | "api_key.revoked"
  | "defaults.changed"
  | "usage.changed"
  | "github.installed"
  | "github.removed"
  | "github.uninstalled"
  | "github.suspended"
  | "github.unsuspended"
  | "billing.checkout_opened"
  | "billing.portal_opened"
  | "billing.plan_changed";

export type AuditEvent = {
  id: number;
  actorType: "user" | "system";
  actorId: string | null;
  actorLabel: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

/** The group an action belongs to, for the page's filter. */
export const AUDIT_GROUPS = {
  members: "Members",
  access: "Roles & access",
  keys: "Keys",
  settings: "Settings",
  github: "GitHub",
  billing: "Billing",
} as const;
export type AuditGroup = keyof typeof AUDIT_GROUPS;

export function auditGroup(action: string): AuditGroup {
  const [kind] = action.split(".");
  if (kind === "member" || kind === "invite" || kind === "request") return "members";
  if (kind === "role" || kind === "access") return "access";
  if (kind === "key" || kind === "api_key") return "keys";
  if (kind === "github") return "github";
  if (kind === "billing") return "billing";
  return "settings";
}

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null);

/** What an event says happened, after its actor ("immad invited …"). */
export function describeAudit(event: Pick<AuditEvent, "action" | "resourceLabel" | "details">): string {
  const what = event.resourceLabel ?? "";
  const d = event.details;
  switch (event.action) {
    case "org.renamed":
      return `renamed the org from ${text(d.from) ?? "?"} to ${text(d.to) ?? what}`;
    case "member.invited":
      return `invited ${what} as ${text(d.role) ?? "a member"}`;
    case "invite.revoked":
      return `revoked the invite to ${what}`;
    case "member.joined":
      return `joined as ${text(d.role) ?? "a member"}`;
    case "request.approved":
      return `let ${what} join as ${text(d.role) ?? "a member"}`;
    case "request.declined":
      return `declined ${what}'s request to join`;
    case "member.removed":
      return `removed ${what}`;
    case "member.left":
      return "left the org";
    case "member.role_changed":
      return `made ${what} ${text(d.role) === "admin" ? "an admin" : "a member"}`;
    case "member.roles_set": {
      const roles = Array.isArray(d.roles) ? d.roles.map(text).filter(Boolean) : [];
      return roles.length ? `gave ${what} the roles ${roles.join(", ")}` : `took ${what}'s roles away`;
    }
    case "role.created":
      return `made the role ${what}`;
    case "role.renamed":
      return `renamed the role ${text(d.from) ?? "?"} to ${what}`;
    case "role.deleted":
      return `deleted the role ${what}`;
    case "access.changed": {
      const who = text(d.role) ?? "Everyone";
      const where = text(d.project) ?? "all projects";
      const level = text(d.level);
      return level ? `gave ${who} ${level} access to ${where}` : `took ${who}'s access to ${where} away`;
    }
    case "key.saved":
      return `saved the org's ${what} key${text(d.hint) ? ` (…${text(d.hint)})` : ""}`;
    case "key.removed":
      return `removed the org's ${what} key`;
    case "api_key.created":
      return `made the API key ${what}${text(d.hint) ? ` (…${text(d.hint)})` : ""}${text(d.expiresAt) ? `, until ${text(d.expiresAt)?.slice(0, 10)}` : ""}`;
    case "api_key.revoked":
      return `revoked the API key ${what}${text(d.hint) ? ` (…${text(d.hint)})` : ""}`;
    case "defaults.changed":
      return `set the org's defaults: model ${text(d.defaultModel) ?? "Outrunner's"}, box ${text(d.boxSize) ?? "Outrunner's"}`;
    case "usage.changed": {
      const limit = text(d.limitPercent);
      const alerts = Array.isArray(d.alertThresholds) ? d.alertThresholds.map(text).filter(Boolean) : [];
      return `set the usage limit to ${limit ? `${limit}%` : "none"}, alerts at ${alerts.length ? alerts.map((a) => `${a}%`).join(", ") : "none"}`;
    }
    case "github.installed":
      return `added the GitHub App on ${what}`;
    case "github.removed":
      return `removed the GitHub App on ${what}`;
    case "github.uninstalled":
      return `saw the GitHub App uninstalled on ${what}`;
    case "github.suspended":
      return `saw the GitHub App suspended on ${what}`;
    case "github.unsuspended":
      return `saw the GitHub App unsuspended on ${what}`;
    case "billing.checkout_opened":
      return `opened checkout for ${what}${text(d.interval) ? `, ${text(d.interval)}ly` : ""}`;
    case "billing.portal_opened":
      return "opened the billing portal";
    case "billing.plan_changed":
      return `saw the plan become ${what}${text(d.status) && d.status !== "active" ? ` (${text(d.status)})` : ""}`;
    default:
      return event.action;
  }
}

/** Who did it: a signed-in person, or Outrunner itself (a webhook, the
 *  reconciler). */
export type AuditActor = { id: string; githubLogin: string; name: string; email: string | null } | "system";

export function actorLabel(actor: AuditActor): string {
  if (actor === "system") return "Outrunner";
  return (actor.githubLogin || actor.name || actor.email || actor.id).slice(0, 200);
}
