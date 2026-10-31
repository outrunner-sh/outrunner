import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getCliOwner } from "@/lib/auth/cli-owner";
import { beginGcpConnection, gcpConnection, selectGcpConnection, verifyGcpConnection, findGcpResource } from "@/lib/db/gcp";
import { checkGcpTarget, gcpNames, GCP_UUID } from "@/lib/runtime/gcp/config";
import { gcpIssuer, gcpJwks } from "@/lib/runtime/gcp/identity";
import { GcpError, checkGcpAccess } from "@/lib/runtime/gcp/api";
import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { GcpBackend } from "@/lib/runtime/sandbox/gcp";
import { AgentHealth } from "@/lib/runtime/agent-protocol";
import { probeStatus } from "@/lib/supabase/probe";

export const maxDuration = 1200;
const probes = new Map<string, Promise<void>>();
async function testConnection(c: NonNullable<Awaited<ReturnType<typeof gcpConnection>>>) {
  let pending = probes.get(c.id);
  if (!pending) {
    pending = (async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try { await checkGcpAccess(c); break; }
        catch (error) {
          if (!(error instanceof GcpError) || ![400, 403].includes(error.status) || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
      }
      const backend = new GcpBackend(c.user_id, async () => c, true);
      const provider = new ComputerRuntimeProvider("user-gcp", backend);
      const secret = randomBytes(32).toString("base64url");
      let id: string | undefined;
      try {
        const made = await provider.provisionComputer({ secret, size: { cpu: 2, memoryGb: 4 }, onBox: async (value) => { id = value; } });
        const target = await provider.agentTarget(made.sandboxId, secret);
        const response = await fetch(`${target.controlBaseUrl}/health`, { headers: target.controlHeaders, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error("The test VM's runtime-agent did not answer its health check.");
        AgentHealth.parse(await response.json());
      } finally {
        if (id && (await findGcpResource(id, c.user_id)).state !== "deleted") await backend.delete(id);
      }
      await verifyGcpConnection(c);
    })();
    probes.set(c.id, pending);
    void pending.finally(() => { if (probes.get(c.id) === pending) probes.delete(c.id); }).catch(() => {});
  }
  return pending;
}
export async function POST(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner) return NextResponse.json({ error: "Sign in with outrunner login first." }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  try {
    if (body.action === "begin") {
      const target = checkGcpTarget(body);
      const issuer = gcpIssuer(), jwks = gcpJwks();
      const c = await beginGcpConnection(owner.id, target);
      return NextResponse.json({ id: c.id, issuer, jwks, ...gcpNames(c) });
    }
    if (typeof body.id !== "string" || !GCP_UUID.test(body.id)) return NextResponse.json({ error: "Choose a valid GCP connection." }, { status: 400 });
    const c = await gcpConnection(owner.id, body.id);
    if (!c) return NextResponse.json({ error: "GCP connection not found." }, { status: 404 });
    if (body.action === "verify") {
      await testConnection(c);
      return NextResponse.json({ connected: true, projectId: c.project_id });
    }
    if (body.action === "use") {
      const size = body.size;
      if (size !== "small" && size !== "medium" && size !== "large") return NextResponse.json({ error: "Choose small, medium, or large." }, { status: 400 });
      await selectGcpConnection(c, size);
      return NextResponse.json({ connected: true, sandbox: "gcp", projectId: c.project_id });
    }
    return NextResponse.json({ error: "Choose begin, verify, or use." }, { status: 400 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["outdated", "missing"].includes(probeStatus(error as { code: string }))) {
      return NextResponse.json({ error: "This deployment needs the GCP sandbox database migration before setup can run." }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the GCP connection. Check the server's database configuration." }, { status: error instanceof GcpError ? 502 : 400 });
  }
}
