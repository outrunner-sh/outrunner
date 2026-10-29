import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit/record";
import { getOwner, type Owner } from "@/lib/auth/owner";
import { environmentSetup } from "@/lib/db/environments";
import {
  environmentSecretSync,
  linkEnvironment,
  SecretSyncAccessError,
  unlinkEnvironment,
} from "@/lib/db/secret-sync";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import {
  describeTarget,
  type DopplerLink,
  type InfisicalLink,
  isSecretProvider,
  PROVIDER_LABELS,
  secretPath,
  SecretSyncRuleError,
  slug,
} from "@/lib/secret-sync/rules";
import { syncEnvironmentSecrets } from "@/lib/secret-sync/sync.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A project's link to its org's Doppler or Infisical connection
 * (docs/secret-sync.md). GET, for anyone who can read the project, says
 * which it's linked to and what each brought at its last sync, by name.
 * PUT links it (where to read, over the connection's own) and DELETE
 * unlinks it: an org admin's. POST syncs it now, as a session starting
 * would, for anyone who can change the project: the answer is names, never
 * a value.
 */

const NOT_FOUND = { error: "Project not found." };

async function caller(request: Request, context: RouteContext): Promise<{ owner: Owner; userId: string; id: string } | Response> {
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json(NOT_FOUND, { status: 404 });
  return { owner, userId: owner.id, id };
}

/** The project's secret sync as the page shows it, or 404. */
async function view(userId: string, id: string): Promise<NextResponse> {
  const sync = await environmentSecretSync(userId, id);
  return sync ? NextResponse.json(sync) : NextResponse.json(NOT_FOUND, { status: 404 });
}

export async function GET(request: Request, context: RouteContext) {
  const c = await caller(request, context);
  if (c instanceof Response) return c;
  return view(c.userId, c.id);
}

export async function PUT(request: Request, context: RouteContext) {
  const c = await caller(request, context);
  if (c instanceof Response) return c;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const provider = body?.provider;
  if (!body || !isSecretProvider(provider)) return NextResponse.json({ error: "Choose Doppler or Infisical." }, { status: 400 });
  let link: DopplerLink | InfisicalLink;
  try {
    link =
      provider === "doppler"
        ? { project: slug(body.project, "The Doppler project"), config: slug(body.config, "The Doppler config") }
        : {
            projectId: slug(body.projectId, "The Infisical project ID"),
            environment: slug(body.environment, "The Infisical environment"),
            path: secretPath(body.path),
          };
  } catch (error) {
    if (error instanceof SecretSyncRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  return savingSettings("the project's secret sync", async () => {
    try {
      const env = await linkEnvironment(c.userId, c.id, provider, link);
      if (!env) return NextResponse.json(NOT_FOUND, { status: 404 });
      const sync = await environmentSecretSync(c.userId, c.id);
      const integration = sync?.integrations[provider];
      await recordAudit({
        orgId: env.orgId,
        actor: c.owner,
        action: "secret_sync.linked",
        resource: { type: "project", id: c.id, label: env.name },
        details: {
          provider: PROVIDER_LABELS[provider],
          ...(integration && { target: describeTarget(provider, integration.settings, link) }),
        },
      });
      return NextResponse.json(sync);
    } catch (error) {
      if (error instanceof SecretSyncAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      if (error instanceof SecretSyncRuleError) return NextResponse.json({ error: error.message }, { status: 409 });
      throw error;
    }
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const c = await caller(request, context);
  if (c instanceof Response) return c;
  const provider = new URL(request.url).searchParams.get("provider");
  if (!isSecretProvider(provider)) return NextResponse.json({ error: "Choose Doppler or Infisical." }, { status: 400 });
  return savingSettings("the project's secret sync", async () => {
    try {
      const env = await unlinkEnvironment(c.userId, c.id, provider);
      if (!env) return NextResponse.json(NOT_FOUND, { status: 404 });
      await recordAudit({
        orgId: env.orgId,
        actor: c.owner,
        action: "secret_sync.unlinked",
        resource: { type: "project", id: c.id, label: env.name },
        details: { provider: PROVIDER_LABELS[provider] },
      });
      return view(c.userId, c.id);
    } catch (error) {
      if (error instanceof SecretSyncAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  });
}

export async function POST(request: Request, context: RouteContext) {
  const c = await caller(request, context);
  if (c instanceof Response) return c;
  const sync = await environmentSecretSync(c.userId, c.id);
  if (!sync) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (!sync.canTest) {
    return NextResponse.json(
      { error: "You can see this project but not change it. Ask an admin of its org for write access." },
      { status: 403 },
    );
  }
  // The project's own variables too, as a session would have them: whether
  // the synced fit beside them is part of what's tested. Only names leave.
  const setup = await environmentSetup(c.userId, c.id);
  await syncEnvironmentSecrets(c.id, { env: setup?.env ?? {}, startHook: null });
  return view(c.userId, c.id);
}
