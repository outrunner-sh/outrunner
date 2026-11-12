import { disconnectGcp, gcpConnection, selectGcpConnection } from "@/lib/db/gcp";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { activeOrgId } from "@/lib/orgs/server";
import { allowsBoxSize } from "@/lib/billing/plans";
import {
  clearDaytonaKey,
  clearE2bConnection,
  clearModalToken,
  getSandboxSettings,
  getStoredE2b,
  setBoxSize,
  setDaytonaKey,
  setE2bConnection,
  setModalToken,
  setSandboxChoice,
  type SandboxChoice,
  type SandboxSettings,
} from "@/lib/db/credentials";
import { boxSize, isBoxSizeId } from "@/lib/runtime/box-sizes";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { daytonaAcceptsKey } from "@/lib/runtime/sandbox/daytona";
import { modalAcceptsToken } from "@/lib/runtime/sandbox/modal";
import { checkModalToken } from "@/lib/runtime/sandbox/modal-token";
import { assertPublicHost, e2bAcceptsKey, e2bUrl } from "@/lib/runtime/user-e2b-checks";
import { buildUserE2bTemplate, refreshUserE2bTemplate } from "@/lib/runtime/user-e2b-template";

/**
 * Where the user's cloud sessions run (Settings → Sandbox): Outrunner's
 * sandboxes, or their own Daytona, Modal or E2B on their key. GET returns the
 * choice and whether each key is stored (its last 4 characters), never a key,
 * and moves their E2B's box template along. PUT sets the choice and, with
 * `daytonaKey`, `modalToken` or `e2bKey` (with a self-hosted E2B's
 * `e2bApiUrl` and `e2bSandboxUrl`), stores a key the provider has accepted,
 * an E2B one starting its template's build; `e2bRebuild` builds that again;
 * with `boxSize`, the size of new sandboxes (one beyond their plan only on
 * their own Modal, which they pay for). DELETE forgets a key
 * (`?key=daytona|modal|e2b`), which moves new sessions back to Outrunner's
 * sandboxes if they ran there.
 */

const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 500;
const CHOICES: readonly SandboxChoice[] = ["outrunner", "daytona", "modal", "gcp", "e2b"];
/** E2B's keys: `e2b_` and 40 hex characters today; a little room either way. */
const E2B_KEY = /^e2b_[A-Za-z0-9]{20,200}$/;

function invalid(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Run a save, answering the database's refusal as JSON the page can show. */
function saving(save: () => Promise<NextResponse>): Promise<Response> {
  return savingSettings("sandbox settings", save);
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return NextResponse.json(await withE2bTemplateMoved(owner.id));
}

/** The user's settings, after a template of their E2B's that's building, or
 *  missing, or outdated, is moved along: what the page shows comes to ready
 *  (or failed) as it polls. */
async function withE2bTemplateMoved(userId: string): Promise<SandboxSettings> {
  const settings = await getSandboxSettings(userId);
  const template = settings.e2b?.connected ? settings.e2b.template : null;
  if (template === null || template === "ready" || template === "failed") return settings;
  await refreshUserE2bTemplate(userId);
  return getSandboxSettings(userId);
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();

  let body: {
    sandbox?: unknown;
    daytonaKey?: unknown;
    modalToken?: unknown;
    e2bKey?: unknown;
    e2bApiUrl?: unknown;
    e2bSandboxUrl?: unknown;
    e2bRebuild?: unknown;
    boxSize?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return invalid("Expected a JSON body.");
  }
  const sandbox = CHOICES.find((c) => c === body?.sandbox);
  if (!sandbox) return invalid("Choose Outrunner, Daytona, Modal, Google Cloud, or E2B.");
  if (body.boxSize !== undefined && !isBoxSizeId(body.boxSize)) return invalid("Choose one of the box sizes.");
  const size = isBoxSizeId(body.boxSize) ? boxSize(body.boxSize) : null;
  if (sandbox === "gcp" && body.boxSize === "x-small") return invalid("Google Cloud supports Small, Medium, and Large sandboxes.");
  // A size beyond the user's plan isn't for Outrunner's sandboxes; their own
  // Modal is on their bill.
  // Within the plan of the org they're looking at (billing is the org's);
  // a box is still sized within its own org's at start (boxSizeOn).
  if (sandbox === "e2b" && size && size.id !== "small") return invalid("E2B sandboxes are Small for now.");
  if (size && sandbox !== "modal" && sandbox !== "gcp" && sandbox !== "e2b" && !allowsBoxSize(await planFor(await activeOrgId().catch(() => undefined)), size.id)) {
    return NextResponse.json({ error: `${size.label} needs a higher plan.` }, { status: 403 });
  }

  return saving(async () => {
    if (body.daytonaKey !== undefined) {
      const key = typeof body.daytonaKey === "string" ? body.daytonaKey.trim() : "";
      if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
        return invalid("That doesn't look like a Daytona API key. Copy it from Daytona → API Keys.");
      }
      let accepted: boolean;
      try {
        accepted = await daytonaAcceptsKey(key);
      } catch (error) {
        console.error("Could not check a Daytona key", error);
        return NextResponse.json(
          { error: "Couldn't reach Daytona to check that key. Try again in a moment." },
          { status: 502 },
        );
      }
      if (!accepted) return invalid("Daytona didn't accept that key. Check it in Daytona → API Keys.");
      await setDaytonaKey(owner.id, key);
    } else if (sandbox === "daytona" && !(await getSandboxSettings(owner.id)).daytona.connected) {
      return invalid("Add your Daytona API key to run sessions on your own Daytona.");
    }

    if (body.modalToken !== undefined) {
      const checked = checkModalToken(body.modalToken);
      if ("error" in checked) return invalid(checked.error);
      const { token } = checked;
      let accepted: boolean;
      try {
        accepted = await modalAcceptsToken(token);
      } catch (error) {
        console.error("Could not check a Modal token", error);
        return NextResponse.json(
          { error: "Couldn't reach Modal to check that token. Try again in a moment." },
          { status: 502 },
        );
      }
      if (!accepted) return invalid("Modal didn't accept that token. Check it in Modal → Settings → API Tokens.");
      await setModalToken(owner.id, token);
    } else if (sandbox === "modal" && !(await getSandboxSettings(owner.id)).modal.connected) {
      return invalid("Add your Modal token to run sessions on your own Modal.");
    }

    if (body.e2bKey !== undefined) {
      const key = typeof body.e2bKey === "string" ? body.e2bKey.trim() : "";
      if (!E2B_KEY.test(key)) return invalid("That doesn't look like an E2B API key (e2b_…). Copy it from E2B → Keys.");
      // Both URLs for a self-hosted E2B, or neither for E2B's cloud.
      const apiUrl = e2bUrl(body.e2bApiUrl);
      const sandboxUrl = e2bUrl(body.e2bSandboxUrl);
      if (apiUrl === undefined || sandboxUrl === undefined) {
        return invalid("A self-hosted E2B's URLs must be https on a public host, like https://e2b-api.example.com.");
      }
      if ((apiUrl === null) !== (sandboxUrl === null)) {
        return invalid("Give both a self-hosted E2B's API URL and its sandbox URL, or neither for E2B's cloud.");
      }
      let accepted: boolean;
      try {
        if (apiUrl && sandboxUrl) await Promise.all([assertPublicHost(apiUrl), assertPublicHost(sandboxUrl)]);
        accepted = await e2bAcceptsKey(key, apiUrl ?? undefined);
      } catch (error) {
        console.error("Could not check an E2B key", error);
        return NextResponse.json(
          { error: `Couldn't reach ${apiUrl ? "that E2B" : "E2B"} to check the key. Check the URLs and try again.` },
          { status: 502 },
        );
      }
      if (!accepted) return invalid("E2B didn't accept that key. Check it in E2B → Keys.");
      await setE2bConnection(owner.id, { apiKey: key, apiUrl, sandboxUrl });
      // Outrunner's box template, built in their account: minutes, in the
      // background; the page follows it to ready.
      const stored = await getStoredE2b(owner.id);
      if (stored) await buildUserE2bTemplate(owner.id, stored);
    } else if (body.e2bRebuild === true) {
      const stored = await getStoredE2b(owner.id);
      if (!stored) return invalid("Add your E2B API key first.");
      await buildUserE2bTemplate(owner.id, stored);
    } else if (sandbox === "e2b" && !(await getSandboxSettings(owner.id)).e2b?.connected) {
      return invalid("Add your E2B API key to run sessions on your own E2B.");
    }

    if (sandbox === "gcp") {
      const c = await gcpConnection(owner.id);
      if (c?.state !== "connected") return invalid("Connect Google Cloud using outrunner sandbox connect gcp first.");
      const wanted = size?.id ?? (await getSandboxSettings(owner.id)).boxSize;
      await selectGcpConnection(c, wanted === "x-small" ? "small" : wanted);
    } else await setSandboxChoice(owner.id, sandbox);
    if (size) await setBoxSize(owner.id, size.id);
    return NextResponse.json(await getSandboxSettings(owner.id));
  });
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();

  const key = new URL(request.url).searchParams.get("key") ?? "daytona";
  if (key !== "daytona" && key !== "modal" && key !== "gcp" && key !== "e2b") {
    return invalid("Say which connection to remove: daytona, modal, gcp, or e2b.");
  }
  return saving(async () => {
    if (key === "gcp") {
      try { await disconnectGcp(owner.id); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not disconnect Google Cloud." }, { status: 409 }); }
    } else if (key === "e2b") await clearE2bConnection(owner.id);
    else await (key === "modal" ? clearModalToken(owner.id) : clearDaytonaKey(owner.id));
    return NextResponse.json(await getSandboxSettings(owner.id));
  });
}
