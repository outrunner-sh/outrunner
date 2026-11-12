/**
 * What the audit log records (20261101115000_audit_events.sql), and how each
 * reads on Settings → Org → Audit log. Pure, for the page and the tests;
 * lib/audit/record.ts writes them.
 *
 * Details hold what a reader needs to know what changed (a role, a plan, a
 * key's last 4), never a secret.
 */

export type AuditAction =
  | "slack_channel.shared"
  | "slack_channel.revoked"
  | "slack_channel.asked"
  | "slack_channel.lookup"
  | "org.renamed"
  | "member.invited"
  | "invite.revoked"
  | "invite.resent"
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
  | "secret_sync.connected"
  | "secret_sync.disconnected"
  | "secret_sync.linked"
  | "secret_sync.unlinked"
  | "tracker.connected"
  | "tracker.disconnected"
  | "tracker.team_connected"
  | "tracker.team_disconnected"
  | "tracker.team_changed"
  | "tracker.rule_changed"
  | "webhook.changed"
  | "webhook.secret_rotated"
  | "defaults.changed"
  | "learning.created"
  | "learning.suggested"
  | "learning.changed"
  | "learning.accepted"
  | "learning.deleted"
  | "usage.changed"
  | "github.installed"
  | "github.removed"
  | "github.share_removed"
  | "github.uninstalled"
  | "github.suspended"
  | "github.unsuspended"
  | "github.rules_bypassed"
  | "billing.checkout_opened"
  | "billing.portal_opened"
  | "billing.plan_changed"
  | "preview.made_public"
  | "preview.made_login"
  | "preview.deleted";

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
  if (kind === "role" || kind === "access" || kind === "preview" || kind === "slack_channel") return "access";
  if (kind === "key" || kind === "api_key" || kind === "secret_sync") return "keys";
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
    case "slack_channel.shared":
      return `enabled shared read-only questions in ${what}`;
    case "slack_channel.revoked":
      return `revoked shared questions in ${what}`;
    case "slack_channel.asked":
      return `asked a shared channel question in ${what}`;
    case "slack_channel.lookup":
      return `looked up ${text(d.tool) ?? "status"} in ${what}`;
    case "org.renamed":
      return `renamed the org from ${text(d.from) ?? "?"} to ${text(d.to) ?? what}`;
    case "member.invited":
      return `invited ${what} as ${text(d.role) ?? "a member"}`;
    case "invite.revoked":
      return `revoked the invite to ${what}`;
    case "invite.resent":
      return d.emailed === true ? `emailed ${what} a new invite link` : `made a new invite link for ${what}`;
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
    case "secret_sync.connected":
      return `connected ${what}${text(d.label) ? ` (${text(d.label)})` : ""}`;
    case "secret_sync.disconnected":
      return `disconnected ${what}${text(d.links) && d.links !== 0 ? `, unlinking ${text(d.links)} project${d.links === 1 ? "" : "s"}` : ""}`;
    case "secret_sync.linked":
      return `linked the project ${what} to ${text(d.provider) ?? "?"}${text(d.target) ? ` (${text(d.target)})` : ""}`;
    case "secret_sync.unlinked":
      return `unlinked the project ${what} from ${text(d.provider) ?? "?"}`;
    case "tracker.connected":
      return `connected ${what}${text(d.label) ? ` (${text(d.label)})` : ""}`;
    case "tracker.disconnected":
      return `disconnected ${what}${text(d.label) ? ` (${text(d.label)})` : ""}`;
    case "tracker.team_connected":
      return `connected the team ${what}`;
    case "tracker.team_disconnected":
      return `disconnected the team ${what}`;
    case "tracker.team_changed":
      return `changed the settings of the team ${what}`;
    case "tracker.rule_changed":
      return `changed a triage rule of the team ${what}`;
    case "webhook.changed":
      return text(d.url) ? `set the API's webhook endpoint to ${text(d.url)}` : "removed the API's webhook endpoint";
    case "webhook.secret_rotated":
      return "rotated the API's webhook signing secret";
    case "api_key.revoked":
      return `revoked the API key ${what}${text(d.hint) ? ` (…${text(d.hint)})` : ""}`;
    case "defaults.changed":
      return `set the org's defaults: model ${text(d.defaultModel) ?? "Outrunner's"}, box ${text(d.boxSize) ?? "Outrunner's"}`;
    case "learning.created":
      return `added the learning ${what}`;
    case "learning.suggested":
      return `suggested the learning ${what}`;
    case "learning.changed":
      return `changed the learning ${what}`;
    case "learning.accepted":
      return `accepted the learning ${what}`;
    case "learning.deleted":
      return `deleted the learning ${what}`;
    case "usage.changed": {
      const limit = text(d.limitPercent);
      const alerts = Array.isArray(d.alertThresholds) ? d.alertThresholds.map(text).filter(Boolean) : [];
      return `set the usage limit to ${limit ? `${limit}%` : "none"}, alerts at ${alerts.length ? alerts.map((a) => `${a}%`).join(", ") : "none"}`;
    }
    case "github.installed":
      return `added the GitHub App on ${what}`;
    case "github.removed":
      return `removed the GitHub App on ${what}`;
    case "github.share_removed":
      return `stopped sharing the GitHub App on ${what} with ${text(d.orgName) ?? "another org"}`;
    case "github.uninstalled":
      return `saw the GitHub App uninstalled on ${what}`;
    case "github.suspended":
      return `saw the GitHub App suspended on ${what}`;
    case "github.unsuspended":
      return `saw the GitHub App unsuspended on ${what}`;
    case "github.rules_bypassed":
      return `merged ${what} past its branch's rules`;
    case "billing.checkout_opened":
      return `opened checkout for ${what}${text(d.interval) ? `, ${text(d.interval)}ly` : ""}`;
    case "billing.portal_opened":
      return "opened the billing portal";
    case "billing.plan_changed":
      return `saw the plan become ${what}${text(d.status) && d.status !== "active" ? ` (${text(d.status)})` : ""}`;
    case "preview.made_public":
      return `made the preview ${what} public: anyone with its link can open it`;
    case "preview.made_login":
      return `made the preview ${what} sign-in only`;
    case "preview.deleted":
      return `deleted the preview ${what}`;
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
