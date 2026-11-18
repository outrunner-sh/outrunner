/**
 * Who is in an org, and how they get in or leave
 * (supabase/migrations/20261028130000_org_members.sql): its members, its open
 * invites, the requests to join it. Every table is the server's alone, so
 * this module reaches them with the service role; the routes calling it check
 * who may (lib/orgs/members.ts).
 */

import type { User } from "@supabase/supabase-js";

import { ADMITTED_KEY, githubLogin, isAdmitted, onAllowlist } from "@/lib/auth/allowlist";
import { hashSecret } from "@/lib/auth/cli-login";
import { connectorsAmong } from "@/lib/automations/connector";
import type { OrgRole } from "@/lib/orgs/active";
import { INVITE_DAYS, newInviteToken } from "@/lib/orgs/invite-token";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** How long after a declined request its asker may ask again. */
export const REQUEST_AGAIN_DAYS = 7;

/** A person as the members page shows them. */
export type Person = {
  userId: string;
  login: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
};

export type Member = Person & {
  role: OrgRole;
  joinedAt: string;
  /** The GitHub organization they joined through (lib/orgs/github-join.ts),
   *  by its login then; null otherwise. For admins' eyes. */
  joinedViaGithub: string | null;
};

export type OpenInvite = {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** Past its expiry, as of when it was read: invite again for a new link. */
  expired: boolean;
};

export type JoinRequest = Person & { id: string; requestEmail: string; createdAt: string };

/** Why a change to an org's members was refused. */
export type MemberRefusal =
  | "invite_invalid"
  | "request_not_pending"
  | "last_admin"
  | "personal_org"
  | "not_a_member";

const REFUSALS: Record<MemberRefusal, string> = {
  invite_invalid: "This invite has been used, withdrawn, or has expired. Ask an admin for a new one.",
  request_not_pending: "That request has been answered already.",
  last_admin: "An org needs an admin. Make someone else an admin first.",
  personal_org: "A personal org is just yours: no one joins or leaves it.",
  not_a_member: "They aren't a member of this org.",
};

export class MemberChangeError extends Error {
  constructor(readonly reason: MemberRefusal) {
    super(REFUSALS[reason]);
    this.name = "MemberChangeError";
  }
}

/** The database's refusal, as the word the functions raise; else the error. */
function refusal(error: { message?: string } | null): Error | null {
  if (!error) return null;
  const word = (error.message ?? "").trim() as MemberRefusal;
  return Object.hasOwn(REFUSALS, word) ? new MemberChangeError(word) : (error as Error);
}

/** The name a person with none gets: a placeholder, not a name to show
 *  where an email would say more. */
export const NO_NAME = "Someone";

function personFrom(user: User | null | undefined, userId: string): Person {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const login = (user && githubLogin(user)) ?? "";
  const name =
    (typeof meta.full_name === "string" && meta.full_name) || (typeof meta.name === "string" && meta.name) || login;
  return {
    userId,
    login,
    name: name || NO_NAME,
    email: user?.email ?? null,
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
  };
}

/** The people behind some user ids, by id. One lookup each: orgs are small. */
export async function people(userIds: readonly string[]): Promise<Map<string, Person>> {
  const admin = createSupabaseAdminClient().auth.admin;
  const found = await Promise.all(
    [...new Set(userIds)].map(async (id) => {
      const { data } = await admin.getUserById(id);
      return [id, personFrom(data.user, id)] as const;
    }),
  );
  return new Map(found);
}

/** An org's members, admins first, then by name. */
export async function listMembers(orgId: string): Promise<Member[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_members")
    .select("user_id, role, created_at, joined_via_github")
    .eq("org_id", orgId);
  if (error) throw error;
  // Not the org's outrunner-connector, a service user its automations run as.
  const connectors = await connectorsAmong((data ?? []).map((m) => m.user_id));
  const humans = (data ?? []).filter((m) => !connectors.has(m.user_id));
  const byId = await people(humans.map((m) => m.user_id));
  return humans
    .map((m) => ({
      ...byId.get(m.user_id)!,
      role: m.role as OrgRole,
      joinedAt: m.created_at,
      joinedViaGithub: m.joined_via_github,
    }))
    .sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin") || a.name.localeCompare(b.name));
}

/** An org's invites not yet accepted or withdrawn, newest first; expired ones
 *  included, for the admin to send again. */
export async function listOpenInvites(orgId: string): Promise<OpenInvite[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_invites")
    .select("id, email, role, invited_by, created_at, expires_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const now = Date.now();
  return (data ?? []).map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role as OrgRole,
    invitedBy: i.invited_by,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    expired: new Date(i.expires_at).getTime() <= now,
  }));
}

/**
 * Invite `email` to the org as `role`, replacing an open invite to the same
 * email. The link's token: shown once, kept only as its hash.
 */
export async function createInvite(input: {
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
}): Promise<{ token: string; invite: OpenInvite }> {
  const supabase = createSupabaseAdminClient();
  const { error: revokeError } = await supabase
    .from("organization_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("org_id", input.orgId)
    .eq("email", input.email)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (revokeError) throw revokeError;
  const token = newInviteToken();
  const { data, error } = await supabase
    .from("organization_invites")
    .insert({
      org_id: input.orgId,
      email: input.email,
      role: input.role,
      token_hash: hashSecret(token),
      invited_by: input.invitedBy,
      expires_at: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id, email, role, invited_by, created_at, expires_at")
    .single();
  if (error) throw error;
  return {
    token,
    invite: {
      id: data.id,
      email: data.email,
      role: data.role as OrgRole,
      invitedBy: data.invited_by,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      expired: false,
    },
  };
}

/**
 * Give an org's open invite a new token's hash and expiry, for resending it
 * (lib/orgs/invite-resend.ts): the old link's hash is no invite's any more,
 * so it stops working. Null when there's no open invite by that id.
 */
export async function rotateInvite(input: {
  orgId: string;
  inviteId: string;
  tokenHash: string;
  expiresAt: string;
}): Promise<OpenInvite | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_invites")
    .update({ token_hash: input.tokenHash, expires_at: input.expiresAt })
    .eq("org_id", input.orgId)
    .eq("id", input.inviteId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id, email, role, invited_by, created_at, expires_at");
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role as OrgRole,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expired: false,
  };
}

/** Withdraw an org's open invite; false when there's none by that id. */
export async function revokeInvite(orgId: string, inviteId: string): Promise<{ email: string } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", inviteId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id, email");
  if (error) throw error;
  return data?.[0] ? { email: data[0].email } : null;
}

/** The email a request to join was made with; null for no such request. */
export async function joinRequestEmail(orgId: string, requestId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_join_requests")
    .select("email")
    .eq("org_id", orgId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  return data?.email ?? null;
}

/** An invite, by its link's token, as its page shows it; null for a token
 *  that's no invite's. */
export async function inviteByToken(token: string): Promise<
  | {
      orgId: string;
      orgName: string;
      email: string;
      role: OrgRole;
      invitedBy: Person | null;
      open: boolean;
    }
  | null
> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organization_invites")
    .select("org_id, email, role, invited_by, expires_at, accepted_at, revoked_at")
    .eq("token_hash", hashSecret(token))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", data.org_id)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org) return null;
  const inviter = data.invited_by ? (await people([data.invited_by])).get(data.invited_by) ?? null : null;
  return {
    orgId: data.org_id,
    orgName: org.name,
    email: data.email,
    role: data.role as OrgRole,
    invitedBy: inviter,
    open: !data.accepted_at && !data.revoked_at && new Date(data.expires_at).getTime() > Date.now(),
  };
}

/** Accept an invite by its token, as `userId` (whose verified emails the
 *  caller checked hold the invite's). The org's id. */
export async function acceptInvite(token: string, userId: string): Promise<string> {
  const { data, error } = await createSupabaseAdminClient().rpc("accept_org_invite", {
    invite_token_hash: hashSecret(token),
    member: userId,
  });
  const refused = refusal(error);
  if (refused) throw refused;
  return data as string;
}

/** Whether any open, unexpired invite is to one of these emails. */
export async function hasOpenInviteFor(emails: readonly string[]): Promise<boolean> {
  if (emails.length === 0) return false;
  const { count, error } = await createSupabaseAdminClient()
    .from("organization_invites")
    .select("id", { count: "exact", head: true })
    .in(
      "email",
      emails.map((e) => e.toLowerCase()),
    )
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** What asking to join an org came to. */
export type JoinRequestOutcome = "requested" | "pending" | "member" | "declined_recently";

/** Ask to join an org as `userId`, by `email` (theirs, whose domain it
 *  claimed). One pending request at a time; after a decline, not again for
 *  REQUEST_AGAIN_DAYS. */
export async function requestToJoin(orgId: string, userId: string, email: string): Promise<JoinRequestOutcome> {
  const supabase = createSupabaseAdminClient();
  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (member) return "member";

  const since = new Date(Date.now() - REQUEST_AGAIN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: recentError } = await supabase
    .from("organization_join_requests")
    .select("status")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .or(`status.eq.pending,and(status.eq.declined,decided_at.gt.${since})`);
  if (recentError) throw recentError;
  if (recent?.some((r) => r.status === "pending")) return "pending";
  if (recent?.some((r) => r.status === "declined")) return "declined_recently";

  const { error } = await supabase.from("organization_join_requests").insert({ org_id: orgId, user_id: userId, email });
  // Asked at the same moment from another tab: that one's the request.
  if (error?.code === "23505") return "pending";
  if (error) throw error;
  return "requested";
}

/** What joining an org through its GitHub organization came to: in (or a
 *  member already), or the database's refusal
 *  (20261119100000_github_org_join.sql). */
export type GitHubJoinOutcome = "joined" | "member" | "personal" | "disabled" | "not_source" | "removed";

/** Let `userId` into `orgId` as a member through GitHub organization
 *  `githubOrg` (installation `installationId`'s): the caller asked GitHub
 *  that they're its active member (lib/orgs/github-join.ts). */
export async function joinOrgViaGithub(
  orgId: string,
  userId: string,
  githubOrg: string,
  installationId: number,
): Promise<GitHubJoinOutcome> {
  const { data, error } = await createSupabaseAdminClient().rpc("join_org_via_github", {
    target_org: orgId,
    member: userId,
    github_org: githubOrg,
    target_installation: installationId,
  });
  if (error) throw error;
  return data as GitHubJoinOutcome;
}

/** The orgs a user is in, and those someone else removed them from (which
 *  only an invite brings them back to), for joining one through GitHub. */
export async function joinStanding(
  userId: string,
): Promise<{ memberOf: ReadonlySet<string>; removedFrom: ReadonlySet<string> }> {
  const supabase = createSupabaseAdminClient();
  const [members, removals] = await Promise.all([
    supabase.from("organization_members").select("org_id").eq("user_id", userId),
    supabase.from("organization_removals").select("org_id, removed_by").eq("user_id", userId),
  ]);
  if (members.error) throw members.error;
  if (removals.error) throw removals.error;
  return {
    memberOf: new Set((members.data ?? []).map((m) => m.org_id)),
    removedFrom: new Set((removals.data ?? []).filter((r) => r.removed_by !== userId).map((r) => r.org_id)),
  };
}

/** Whether a team org lets its GitHub organization's members join without an
 *  invite (organization_settings.join_via_github): on with nothing saved.
 *  Off before the migration, when no one can join that way anyway. */
export async function getJoinViaGithub(orgId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .select("join_via_github")
    .eq("org_id", orgId)
    .maybeSingle();
  const status = probeStatus(error);
  if (status === "missing" || status === "outdated") return false;
  if (error) throw error;
  return data?.join_via_github ?? true;
}

/** Set it, as admin `by`; the org's other settings are left as they are. */
export async function setJoinViaGithub(orgId: string, enabled: boolean, by: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .upsert({ org_id: orgId, join_via_github: enabled, updated_by: by }, { onConflict: "org_id" });
  if (error) throw error;
}

/** An org's pending requests to join, oldest first. */
export async function listJoinRequests(orgId: string): Promise<JoinRequest[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_join_requests")
    .select("id, user_id, email, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at");
  if (error) throw error;
  const byId = await people((data ?? []).map((r) => r.user_id));
  return (data ?? []).map((r) => ({ ...byId.get(r.user_id)!, id: r.id, requestEmail: r.email, createdAt: r.created_at }));
}

/** Approve a pending request in `orgId` as `role`: the asker's user id. */
export async function approveJoinRequest(orgId: string, requestId: string, decider: string, role: OrgRole): Promise<string> {
  await requireRequestIn(orgId, requestId);
  const { data, error } = await createSupabaseAdminClient().rpc("approve_join_request", {
    request: requestId,
    decider,
    member_role: role,
  });
  const refused = refusal(error);
  if (refused) throw refused;
  return data as string;
}

/** Decline a pending request in `orgId`. */
export async function declineJoinRequest(orgId: string, requestId: string, decider: string): Promise<void> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_join_requests")
    .update({ status: "declined", decided_by: decider, decided_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new MemberChangeError("request_not_pending");
}

/** A request id from another org reads as answered: no reaching across orgs. */
async function requireRequestIn(orgId: string, requestId: string): Promise<void> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_join_requests")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new MemberChangeError("request_not_pending");
}

/** Take `userId` out of a team org; `remover` is them when they leave. */
export async function removeMember(orgId: string, userId: string, remover: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().rpc("remove_org_member", {
    target_org: orgId,
    member: userId,
    remover,
  });
  const refused = refusal(error);
  if (refused) throw refused;
}

/** Make a member of a team org an admin or a member. */
export async function setMemberRole(orgId: string, userId: string, role: OrgRole): Promise<void> {
  const { error } = await createSupabaseAdminClient().rpc("set_org_member_role", {
    target_org: orgId,
    member: userId,
    member_role: role,
  });
  const refused = refusal(error);
  if (refused) throw refused;
}

/** The admins of an org, for telling them of a request. */
export async function orgAdmins(orgId: string): Promise<Person[]> {
  return (await listMembers(orgId)).filter((m) => m.role === "admin");
}

/** The team orgs a user is a member of, by id. */
export async function teamOrgIds(userId: string): Promise<string[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("organization_members").select("org_id").eq("user_id", userId);
  if (error) throw error;
  const ids = (data ?? []).map((m) => m.org_id);
  if (ids.length === 0) return [];
  const { data: orgs, error: orgsError } = await supabase
    .from("organizations")
    .select("id")
    .in("id", ids)
    .is("personal_owner_id", null);
  if (orgsError) throw orgsError;
  return (orgs ?? []).map((o) => o.id);
}

/**
 * Let a user in past the allowlist, or take that away (lib/auth/allowlist.ts
 * isAdmitted): app_metadata, which only the service role writes.
 */
export async function setAdmitted(userId: string, admitted: boolean): Promise<void> {
  const { error } = await createSupabaseAdminClient().auth.admin.updateUserById(userId, {
    app_metadata: { [ADMITTED_KEY]: admitted },
  });
  if (error) throw error;
}

/**
 * After someone leaves or is removed from an org: if no team org holds them
 * any longer and the allowlist doesn't name them, the way in an org gave them
 * closes. Their personal org and its sessions stay, for when they're let in
 * again.
 */
export async function closeAdmissionIfAlone(userId: string): Promise<void> {
  if ((await teamOrgIds(userId)).length > 0) return;
  const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(userId);
  if (error) throw error;
  if (!data.user || !isAdmitted(data.user) || onAllowlist(data.user)) return;
  await setAdmitted(userId, false);
}
