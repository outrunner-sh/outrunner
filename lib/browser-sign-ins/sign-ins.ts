/**
 * The desktop browser's sign-ins, carried from one of a person's sessions to
 * their next in the same project. Every new session gets a box of its own
 * (lib/runtime/computer-scope.ts), so its browser would start signed out of
 * everything. The box's agent sends the browser's cookies and localStorage as
 * they change, and a new box asks for them back before its browser first
 * starts (app/api/runtime/browser-sign-ins; the box's side is
 * runtime-agent/internal/desktop/sign_ins.go).
 *
 * - Whose: the owner and project of the session the box was made for, never
 *   anything the box's request says (boxScope). A project's shared box, from
 *   before every session had its own, keeps none: its browser was every
 *   session's on it.
 * - Sealed with CREDENTIALS_ENCRYPTION_KEY, with the owner and project inside
 *   the seal (sealSignIns), so a row moved to another person or project in
 *   the database doesn't open as theirs.
 * - Kept RETENTION_DAYS from when they were last saved or used.
 * - On unless the person turns it off (Settings → Sandbox), which deletes them.
 *
 * Never logged: a cookie or localStorage value is a live sign-in.
 *
 * Pure, so it is unit-tested in Node; the database is ./sign-ins.deps.ts's.
 */

/** How long sign-ins are kept after they were last saved or used. */
export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The most a box sends, as JSON (the agent's maxSignInsBytes). */
export const MAX_STATE_BYTES = 512 * 1024;
/** Bounds on what a storageState holds, past any real browser's. */
const MAX_COOKIES = 5000;
const MAX_ORIGINS = 500;
const MAX_ITEMS = 5000;

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};
export type OriginState = { origin: string; localStorage: { name: string; value: string }[] };
/** Playwright's storageState, as the box's agent reads and writes it. */
export type StorageState = { cookies: Cookie[]; origins: OriginState[] };

/** Whose sign-ins: a person, in a project. */
export type SignInScope = { ownerId: string; projectId: string };

/** A row of them, as stored. */
export type StoredSignIns = { stateCiphertext: string; savedAt: string; expiresAt: string };

const SAME_SITE = new Set(["Strict", "Lax", "None"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An origin as the browser has them: an http or https URL with nothing past its host. */
function isOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function parseCookie(value: unknown): Cookie | null {
  if (!isObject(value)) return null;
  const { name, value: cookieValue, domain, path, expires, httpOnly, secure, sameSite } = value;
  if (
    typeof name !== "string" || name === "" ||
    typeof cookieValue !== "string" ||
    typeof domain !== "string" || domain === "" || domain.length > 255 ||
    typeof path !== "string" ||
    typeof expires !== "number" || !Number.isFinite(expires) ||
    typeof httpOnly !== "boolean" || typeof secure !== "boolean" ||
    typeof sameSite !== "string" || !SAME_SITE.has(sameSite)
  ) {
    return null;
  }
  return { name, value: cookieValue, domain, path, expires, httpOnly, secure, sameSite: sameSite as Cookie["sameSite"] };
}

function parseOrigin(value: unknown): OriginState | null {
  if (!isObject(value) || !isOrigin(value.origin) || !Array.isArray(value.localStorage) || value.localStorage.length > MAX_ITEMS) {
    return null;
  }
  const items: OriginState["localStorage"] = [];
  for (const item of value.localStorage) {
    if (!isObject(item) || typeof item.name !== "string" || typeof item.value !== "string") return null;
    items.push({ name: item.name, value: item.value });
  }
  return { origin: value.origin, localStorage: items };
}

/** `value` as a storageState, only the fields one has; null when it isn't one. */
export function parseStorageState(value: unknown): StorageState | null {
  if (!isObject(value)) return null;
  const cookies = value.cookies ?? [];
  const origins = value.origins ?? [];
  if (!Array.isArray(cookies) || !Array.isArray(origins) || cookies.length > MAX_COOKIES || origins.length > MAX_ORIGINS) {
    return null;
  }
  const state: StorageState = { cookies: [], origins: [] };
  for (const raw of cookies) {
    const cookie = parseCookie(raw);
    if (!cookie) return null;
    state.cookies.push(cookie);
  }
  for (const raw of origins) {
    const origin = parseOrigin(raw);
    if (!origin) return null;
    state.origins.push(origin);
  }
  return state;
}

/** When sign-ins saved or used at `now` stop being kept. */
export function keptUntil(now: number): string {
  return new Date(now + RETENTION_MS).toISOString();
}

/** What's sealed: the sign-ins, and whose they are. */
type Sealed = { v: 1; ownerId: string; projectId: string; state: StorageState };

/** `state` sealed for `scope`, as stored at `now`. */
export function sealSignIns(scope: SignInScope, state: StorageState, seal: (plaintext: string) => string, now: number): StoredSignIns {
  const sealed: Sealed = { v: 1, ownerId: scope.ownerId, projectId: scope.projectId, state };
  return { stateCiphertext: seal(JSON.stringify(sealed)), savedAt: new Date(now).toISOString(), expiresAt: keptUntil(now) };
}

/**
 * The sign-ins in `stored`, if they're `scope`'s and still kept at `now`:
 * null past their expiry, and null for a row that doesn't open, or opens as
 * another person's or project's.
 */
export function openSignIns(scope: SignInScope, stored: StoredSignIns, open: (sealed: string) => string, now: number): StorageState | null {
  if (Date.parse(stored.expiresAt) <= now) return null;
  let sealed: unknown;
  try {
    sealed = JSON.parse(open(stored.stateCiphertext));
  } catch {
    return null;
  }
  if (!isObject(sealed) || sealed.v !== 1 || sealed.ownerId !== scope.ownerId || sealed.projectId !== scope.projectId) return null;
  return parseStorageState(sealed.state);
}

/**
 * Whose a box's sign-ins are: the owner and project of the one session it
 * was made for (runtime_computers.workspace_id), the box's owner's, in its
 * org. Null for a project's shared box, or a session that isn't the box's.
 */
export function boxScope(
  computer: { id: string; ownerId: string; orgId: string | null; workspaceId: string | null },
  session: { id: string; ownerId: string; orgId: string | null; projectId: string } | null,
): SignInScope | null {
  if (!computer.workspaceId || !session || session.id !== computer.workspaceId) return null;
  if (session.ownerId !== computer.ownerId || (session.orgId ?? null) !== (computer.orgId ?? null)) return null;
  return { ownerId: session.ownerId, projectId: session.projectId };
}

/** The sites sign-ins are for, each once, in order: their cookies' hosts and
 *  their origins'. What Settings lists; never a value. */
export function signInSites(state: StorageState): string[] {
  const sites = new Set<string>();
  for (const cookie of state.cookies) sites.add(cookie.domain.replace(/^\./, "").toLowerCase());
  for (const origin of state.origins) sites.add(new URL(origin.origin).host);
  return [...sites].sort();
}

/** The database, as a box's call needs it. */
export type SignInStore = {
  /** Whether the person keeps their sign-ins (on with no choice made). */
  keeps(ownerId: string): Promise<boolean>;
  load(scope: SignInScope): Promise<StoredSignIns | null>;
  save(scope: SignInScope, stored: StoredSignIns): Promise<void>;
  /** Pushes out how long they're kept: they were used. */
  touch(scope: SignInScope, expiresAt: string): Promise<void>;
  remove(scope: SignInScope): Promise<void>;
};

export type BoxCallAnswer = { status: number; body: Record<string, unknown> };

/**
 * A box's call for `scope`'s sign-ins, answered: `{ op: "load" }` is the
 * sign-ins kept, `{ state: null }` for none (none saved, past their expiry,
 * unreadable, or not kept), and their expiry pushed out; `{ op: "save",
 * state }` keeps `state` as them (an empty one deletes them), or drops it
 * when the person doesn't keep theirs.
 */
export async function answerBoxCall(
  scope: SignInScope,
  call: unknown,
  store: SignInStore,
  crypto: { seal: (plaintext: string) => string; open: (sealed: string) => string },
  now: number,
): Promise<BoxCallAnswer> {
  if (!isObject(call) || (call.op !== "load" && call.op !== "save")) {
    return { status: 400, body: { error: "Say whether to load or save the sign-ins." } };
  }
  if (call.op === "load") {
    if (!(await store.keeps(scope.ownerId))) return { status: 200, body: { state: null } };
    const stored = await store.load(scope);
    if (!stored) return { status: 200, body: { state: null } };
    const state = openSignIns(scope, stored, crypto.open, now);
    if (!state) {
      // Past its expiry, or of no use to anyone: gone now, not at the sweep.
      await store.remove(scope);
      return { status: 200, body: { state: null } };
    }
    await store.touch(scope, keptUntil(now));
    return { status: 200, body: { state } };
  }

  const state = parseStorageState(call.state);
  if (!state) return { status: 400, body: { error: "That isn't a browser's sign-ins." } };
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) {
    return { status: 413, body: { error: `Sign-ins are kept up to ${MAX_STATE_BYTES} bytes.` } };
  }
  if (!(await store.keeps(scope.ownerId))) return { status: 200, body: { kept: false } };
  if (state.cookies.length === 0 && state.origins.length === 0) {
    await store.remove(scope);
    return { status: 200, body: { kept: true } };
  }
  await store.save(scope, sealSignIns(scope, state, crypto.seal, now));
  return { status: 200, body: { kept: true } };
}
