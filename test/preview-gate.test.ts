import assert from "node:assert/strict";
import { test } from "node:test";

import type { Preview } from "@/lib/db/previews";
import { askedMode, previewLabel, previewMode, previewPort, previewsSupported } from "@/lib/previews/rules";
import { type GateDeps, resolvePreview, wakeTarget } from "@/lib/previews/resolve";
import { mintSession, mintTicket, previewSigningKey, sessionUser, SESSION_TTL_SECONDS, TicketLedger, TICKET_TTL_SECONDS } from "@/lib/previews/tokens";
import type { AccessLevel } from "@/lib/orgs/access";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";

const KEY = previewSigningKey("test-credentials-key");
const SLUG = "abcdefghij0123456789";
const OTHER = "zyxwvutsrq9876543210";
const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const NOW = Date.UTC(2026, 10, 3, 15, 0, 0);

test("a ticket and a session are each good only as themselves, for their preview, until they expire", () => {
  const ticket = mintTicket(KEY, SLUG, MEMBER, NOW);
  const session = mintSession(KEY, SLUG, MEMBER, NOW);
  assert.equal(sessionUser(KEY, session, SLUG, NOW), MEMBER);
  assert.equal(sessionUser(KEY, ticket, SLUG, NOW), null, "a ticket isn't a session");
  assert.equal(sessionUser(KEY, session, OTHER, NOW), null, "nor for another preview");
  assert.equal(sessionUser(previewSigningKey("another"), session, SLUG, NOW), null);
  assert.equal(sessionUser(KEY, session, SLUG, NOW + (SESSION_TTL_SECONDS + 1) * 1000), null);
  const ledger = new TicketLedger();
  assert.equal(ledger.redeem(KEY, session, SLUG, NOW), null, "a session isn't a ticket");
  assert.equal(new TicketLedger().redeem(KEY, ticket, SLUG, NOW + (TICKET_TTL_SECONDS + 1) * 1000), null);
});

test("a tampered token signs no one in", () => {
  const session = mintSession(KEY, SLUG, MEMBER, NOW);
  const [payload, signature] = session.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), u: OWNER })).toString("base64url");
  for (const bad of [`${forged}.${signature}`, `${payload}.${signature.slice(1)}`, payload, `${session}.x`, "", "."]) {
    assert.equal(sessionUser(KEY, bad, SLUG, NOW), null, bad);
  }
});

test("a ticket signs in once", () => {
  const ledger = new TicketLedger();
  const ticket = mintTicket(KEY, SLUG, MEMBER, NOW);
  assert.equal(ledger.redeem(KEY, ticket, OTHER, NOW), null, "not at another preview");
  assert.equal(ledger.redeem(KEY, ticket, SLUG, NOW), MEMBER);
  assert.equal(ledger.redeem(KEY, ticket, SLUG, NOW + 1000), null);
});

// --- The gate ---------------------------------------------------------------

function preview(overrides: Partial<Preview> = {}): Preview {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    slug: SLUG,
    workspaceId: "55555555-5555-4555-8555-555555555555",
    orgId: "66666666-6666-4666-8666-666666666666",
    port: 3000,
    label: "Web",
    mode: "login",
    createdBy: OWNER,
    createdAt: "2026-11-03T15:00:00Z",
    updatedAt: "2026-11-03T15:00:00Z",
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    projectId: "77777777-7777-4777-8777-777777777777",
    orgId: "66666666-6666-4666-8666-666666666666",
    ownerId: OWNER,
    provider: "daytona",
    status: "ready",
    computerId: "88888888-8888-4888-8888-888888888888",
    ...overrides,
  } as Workspace;
}

const READY_BOX = { status: "ready", daytonaSandboxId: "sandbox-1" } as RuntimeComputer;
const UPSTREAM = { baseUrl: "https://3000-sandbox-1.proxy.daytona.works", headers: { "x-daytona-preview-token": "t" }, hostHeader: "upstream" as const };

function deps(
  o: { preview?: Preview | null; workspace?: Workspace | null; box?: RuntimeComputer | null; levels?: Record<string, AccessLevel>; members?: string[] } = {},
): GateDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    key: KEY,
    appBase: "https://app.outrunner.sh",
    now: () => NOW,
    preview: async () => (o.preview === undefined ? preview() : o.preview),
    workspace: async () => (o.workspace === undefined ? workspace() : o.workspace),
    box: async () => (o.box === undefined ? READY_BOX : o.box),
    projectLevel: async (userId) => o.levels?.[userId] ?? null,
    isMember: async (userId) => (o.members ?? [OWNER, MEMBER]).includes(userId),
    upstream: async (_w, sandboxId, port) => {
      asked.push(`${sandboxId}:${port}`);
      return UPSTREAM;
    },
  };
}

const as = (userId: string) => mintSession(KEY, SLUG, userId, NOW);

test("a login preview sends a visitor who isn't signed in to sign in at the app", async () => {
  const decision = await resolvePreview(deps(), SLUG, null);
  assert.deepEqual(decision, { kind: "login", signInUrl: `https://app.outrunner.sh/previews/${SLUG}`, ttlMs: 10_000 });
  // A session for another preview, or a forged one, is no session.
  assert.equal((await resolvePreview(deps(), SLUG, mintSession(KEY, OTHER, OWNER, NOW))).kind, "login");
});

test("a login preview lets in its owner and members who can read the repository, and no one else", async () => {
  const d = deps({ levels: { [MEMBER]: "read" } });
  assert.equal((await resolvePreview(d, SLUG, as(OWNER))).kind, "proxy");
  const member = await resolvePreview(d, SLUG, as(MEMBER));
  assert.deepEqual(member, { kind: "proxy", upstream: UPSTREAM, mode: "login", ttlMs: 10_000 });
  assert.deepEqual(d.asked, ["sandbox-1:3000", "sandbox-1:3000"]);
  const stranger = await resolvePreview(d, SLUG, as(STRANGER));
  assert.equal(stranger.kind === "page" && stranger.page, "denied");
});

test("an owner removed from the org is shut out of their session's login previews", async () => {
  const decision = await resolvePreview(deps({ members: [MEMBER] }), SLUG, as(OWNER));
  assert.equal(decision.kind === "page" && decision.page, "denied");
});

test("a public preview lets in anyone, signed in or not, with access or not", async () => {
  const d = deps({ preview: preview({ mode: "public" }) });
  assert.equal((await resolvePreview(d, SLUG, null)).kind, "proxy");
  assert.equal((await resolvePreview(d, SLUG, as(STRANGER))).kind, "proxy");
});

test("a deleted preview, or an ended session, shows its page", async () => {
  const gone = await resolvePreview(deps({ preview: null }), SLUG, as(OWNER));
  assert.equal(gone.kind === "page" && `${gone.status} ${gone.page}`, "404 missing");
  const ended = await resolvePreview(deps({ workspace: workspace({ status: "destroyed" }) }), SLUG, as(OWNER));
  assert.equal(ended.kind === "page" && `${ended.status} ${ended.page}`, "410 ended");
  const malformed = await resolvePreview(deps(), "../../etc", null);
  assert.equal(malformed.kind === "page" && malformed.page, "missing");
});

test("the agent's port and the provider's never get through, whatever the row says", async () => {
  for (const port of [8080, 2280, 22222, 22, 80]) {
    const d = deps({ preview: preview({ mode: "public", port }) });
    const decision = await resolvePreview(d, SLUG, as(OWNER));
    assert.equal(decision.kind === "page" && decision.page, "missing", String(port));
    assert.deepEqual(d.asked, [], "the box is never asked for a way in");
  }
});

test("an asleep session shows its page, offering its owner alone to wake it", async () => {
  const d = deps({ workspace: workspace({ status: "suspended" }), levels: { [MEMBER]: "read" } });
  const owner = await resolvePreview(d, SLUG, as(OWNER));
  assert.deepEqual(owner, { kind: "page", status: 503, page: "asleep", ttlMs: 3_000, canWake: true });
  const member = await resolvePreview(d, SLUG, as(MEMBER));
  assert.equal(member.kind === "page" && member.canWake, false);
  const archived = await resolvePreview(deps({ preview: preview({ mode: "public" }), workspace: workspace({ status: "archived" }) }), SLUG, null);
  assert.equal(archived.kind === "page" && `${archived.page} ${archived.canWake}`, "asleep false");
  // A session still marked up whose box stopped is asleep too.
  const stopped = await resolvePreview(deps({ box: { ...READY_BOX, status: "stopped" } }), SLUG, as(OWNER));
  assert.equal(stopped.kind === "page" && stopped.page, "asleep");
  // Nothing the lifecycle route could do there (it resumes a suspended
  // session, restores an archived one): no button that can only fail.
  assert.equal(stopped.kind === "page" && stopped.canWake, false);
  const failed = await resolvePreview(deps({ workspace: workspace({ status: "failed" }) }), SLUG, as(OWNER));
  assert.equal(failed.kind === "page" && `${failed.page} ${failed.canWake}`, "asleep false");
  const suspending = await resolvePreview(deps({ workspace: workspace({ status: "suspending" }) }), SLUG, as(OWNER));
  assert.equal(suspending.kind === "page" && suspending.canWake, false);
  const waking = await resolvePreview(deps({ workspace: workspace({ status: "resuming" }) }), SLUG, as(OWNER));
  assert.equal(waking.kind === "page" && waking.page, "starting");
});

test("a login preview reuses its access check for wake; a public preview checks membership", async () => {
  let memberChecks = 0;
  const login = deps({ workspace: workspace({ status: "suspended" }) });
  login.isMember = async () => {
    memberChecks += 1;
    return true;
  };
  const loginPage = await resolvePreview(login, SLUG, as(OWNER));
  assert.equal(loginPage.kind === "page" && loginPage.canWake, true);
  assert.equal(memberChecks, 1, "the login access check also establishes wake access");

  memberChecks = 0;
  const publicPreview = deps({ preview: preview({ mode: "public" }), workspace: workspace({ status: "suspended" }) });
  publicPreview.isMember = async () => {
    memberChecks += 1;
    return true;
  };
  const publicPage = await resolvePreview(publicPreview, SLUG, as(OWNER));
  assert.equal(publicPage.kind === "page" && publicPage.canWake, true);
  assert.equal(memberChecks, 1, "public previews still check membership before offering wake");
});

test("a session where Outrunner can't reach the box's ports says so", async () => {
  const modal = await resolvePreview(deps({ workspace: workspace({ provider: "user-modal" }) }), SLUG, as(OWNER));
  assert.equal(modal.kind === "page" && modal.page, "unsupported");
});

test("only the session's owner can wake it from its preview, and only once it's paused or archived", async () => {
  const d = deps({ workspace: workspace({ status: "suspended" }) });
  assert.equal((await wakeTarget(d, SLUG, as(OWNER)))?.id, workspace().id);
  assert.equal(await wakeTarget(d, SLUG, as(MEMBER)), null);
  assert.equal(await wakeTarget(d, SLUG, null), null);
  assert.equal(await wakeTarget(deps({ workspace: workspace({ status: "failed" }) }), SLUG, as(OWNER)), null);
  assert.equal((await wakeTarget(deps({ workspace: workspace({ status: "archived" }) }), SLUG, as(OWNER)))?.id, workspace().id);
  // An owner removed from the org holds a session cookie still, and could
  // be on a public preview, where no one else's access is asked: no wake.
  const removed = deps({ preview: preview({ mode: "public" }), workspace: workspace({ status: "suspended" }), members: [MEMBER] });
  assert.equal(await wakeTarget(removed, SLUG, as(OWNER)), null);
  const page = await resolvePreview(removed, SLUG, as(OWNER));
  assert.equal(page.kind === "page" && `${page.page} ${page.canWake}`, "asleep false");
});

test("what's asked for a preview is read strictly", () => {
  assert.equal(previewPort(3000), 3000);
  assert.equal(previewPort("5173"), 5173);
  assert.ok(Number.isNaN(previewPort("3000; rm")));
  assert.equal(previewLabel("  Web   app "), "Web app");
  assert.equal(previewLabel(""), null);
  assert.equal(previewLabel("x".repeat(81)), undefined);
  assert.equal(previewMode("public"), "public");
  assert.equal(previewMode("open"), undefined);
  assert.equal(askedMode({ authenticated: false }), "public");
  assert.equal(askedMode({ authenticated: true }), "login");
  assert.equal(askedMode({ mode: "login", authenticated: false }), "login");
  assert.equal(previewMode(askedMode({ authenticated: "no" })), undefined);
  assert.equal(previewsSupported("daytona"), true);
  assert.equal(previewsSupported("neev"), true);
  assert.equal(previewsSupported("local"), false);
});
