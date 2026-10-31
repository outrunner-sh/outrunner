import assert from "node:assert/strict";
import { test } from "node:test";
import { GcpBackend, assertGcpOwnership, gcpInstanceBody, type GcpBackendDeps } from "@/lib/runtime/sandbox/gcp";
import { GcpApi, GcpError } from "@/lib/runtime/gcp/api";
import { checkGcpTarget, gcpMachine, type GcpConnection, type GcpResource } from "@/lib/runtime/gcp/config";
import { BOX_IMAGE } from "@/lib/runtime/box-image";
import { PLANS } from "@/lib/billing/plans";
import { boxSizeOn, providerForNewSessions, providerNamed, sandboxOf } from "@/lib/runtime/sandbox-choice";
import { isLiveMeteredComputer } from "@/lib/billing/limits";
import { onRuntimeComputer } from "@/lib/runtime/types";
import { previewsSupported } from "@/lib/previews/rules";
import { NoGcpConnectionError } from "@/lib/runtime/user-gcp-provider";

const c: GcpConnection = { id: "00000000-0000-4000-a000-000000000001", user_id: "user", project_id: "sandbox-project", project_number: "123456789", zone: "us-central1-a", state: "connected", created_at: "2026-10-31T00:00:00Z", verified_at: "2026-10-31T00:00:00Z" };
function fixture(options: { missing?: number; broken?: boolean; badTools?: boolean; detachedDisk?: boolean } = {}) {
  const r: GcpResource = { id: "00000000-0000-4000-a000-000000000002", connection_id: c.id, user_id: c.user_id, instance_name: "outrunner-test", instance_id: "123", state: "stopped", probe: false, created_at: c.created_at };
  const vm = { id: "123", status: "TERMINATED", labels: { "outrunner-connection": c.id, "outrunner-resource": r.id }, machineType: "e2-custom-2-4096" };
  const log: { method: string; path: string; body?: unknown }[] = [];
  let clock = Date.parse("2026-10-31T01:00:00Z");
  let records = 0;
  const api = { connection: c, request: async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    log.push({ method, path, body });
    if (method === "GET" && path.includes("/disks/")) {
      if (options.detachedDisk) return { labels: vm.labels } as T;
      throw new GcpError(404, "disk lookup");
    }
    if (method === "GET") { if (options.missing) throw new GcpError(options.missing, "VM lookup"); return vm as T; }
    if (path.endsWith("/start")) vm.status = "RUNNING";
    if (path.endsWith("/stop")) vm.status = "TERMINATED";
    if (path.includes("/instances?")) vm.status = "RUNNING";
    return { name: "op", status: "DONE" } as T;
  }, wait: async () => {} } as GcpApi;
  const deps: Partial<GcpBackendDeps> = {
    find: async (id, user) => { assert.equal(id, r.id); assert.equal(user, c.user_id); return { ...r }; },
    connection: async (user, id) => { assert.equal(user, c.user_id); assert.equal(id, c.id); return c; },
    record: async () => { records++; return { ...r, instance_id: null, state: "creating" }; },
    update: async (_id, patch) => { Object.assign(r, patch); },
    api: () => api, close: () => {}, forward: async () => "http://127.0.0.1:1234",
    exec: async (_c, _r, command) => {
      if (options.broken) throw new GcpError(403, "SSH");
      return { stdout: "", stderr: "", exitCode: options.badTools && command.includes("docker exec") ? 1 : 0 };
    }, now: () => clock, sleep: async (ms) => { clock += ms; },
  };
  return { c, r, vm, log, deps, records: () => records, backend: new GcpBackend(c.user_id, async () => c, false, deps) };
}
test("GCP validates target IDs and rejects unsupported VM sizes before creating resources", async () => {
  assert.deepEqual(checkGcpTarget({ projectId: c.project_id, projectNumber: c.project_number, zone: c.zone }), { projectId: c.project_id, projectNumber: c.project_number, zone: c.zone });
  for (const bad of ["../other", "project;whoami", "UPPERCASE"]) assert.throws(() => checkGcpTarget({ projectId: bad, projectNumber: c.project_number, zone: c.zone }));
  assert.equal(gcpMachine({ cpu: 8, memoryGb: 16 }), "e2-custom-8-16384");
  const f = fixture(); await assert.rejects(f.backend.create({}, { cpu: 1, memoryGb: 2 }), /Small/); assert.equal(f.records(), 0);
});
test("a new GCP VM is private, has no cloud service account, and retains the pinned image and owned boot disk", () => {
  const f = fixture(); const body = gcpInstanceBody(c, f.r);
  assert.deepEqual(body.serviceAccounts, []); assert.deepEqual(body.networkInterfaces[0].accessConfigs, []);
  assert.equal(body.disks[0].autoDelete, true); assert.equal(body.disks[0].initializeParams.labels["outrunner-resource"], f.r.id);
  const script = body.metadata.items.find((i) => i.key === "startup-script")!.value;
  assert.ok(script.includes(BOX_IMAGE)); assert.ok(script.includes("/var/lib/outrunner/home"));
  assert.equal(body.metadata.items.find((i) => i.key === "enable-oslogin")!.value, "TRUE");
});
test("GCP refuses a resource in another connection, owner, or a replacement VM with the same name", () => {
  const f = fixture(); assert.doesNotThrow(() => assertGcpOwnership(c, f.r, f.vm));
  assert.throws(() => assertGcpOwnership({ ...c, id: "another" }, f.r, f.vm));
  assert.throws(() => assertGcpOwnership(c, { ...f.r, user_id: "another" }, f.vm));
  assert.throws(() => assertGcpOwnership(c, f.r, { ...f.vm, id: "replacement" }));
});
test("GCP stop retains the VM and disk; restore uses the recorded connection after the default changes", async () => {
  const f = fixture(); const backend = new GcpBackend(c.user_id, async () => { throw new Error("default should never be read for an existing box"); }, false, f.deps);
  await backend.pause(f.r.id); const restored = await backend.restore(f.r.id);
  assert.equal(restored?.id, f.r.id); assert.equal(f.r.state, "ready");
  assert.equal(f.log.filter((a) => a.method === "DELETE").length, 0); assert.ok(f.log.some((a) => a.path.endsWith("/start")));
});
test("GCP distinguishes missing VM from refused access", async () => {
  const missing = fixture({ missing: 404 }); assert.equal(await missing.backend.alive(missing.r.id), false); assert.equal(await missing.backend.restore(missing.r.id), null);
  const denied = fixture({ missing: 403 }); await assert.rejects(denied.backend.alive(denied.r.id), /HTTP 403/); await assert.rejects(denied.backend.restore(denied.r.id), /HTTP 403/);
});
test("a failed GCP restore pauses the original VM and never deletes its workspace", async () => {
  const f = fixture({ broken: true }); await assert.rejects(f.backend.restore(f.r.id), /HTTP 403/);
  assert.ok(f.log.some((a) => a.path.endsWith("/stop"))); assert.equal(f.log.filter((a) => a.method === "DELETE").length, 0);
});
test("a failed new GCP image is cleaned up, including a detached owned boot disk", async () => {
  const f = fixture({ badTools: true, detachedDisk: true }); await assert.rejects(f.backend.create({}), /pinned tool/);
  assert.equal(f.records(), 1); assert.equal(f.r.state, "deleted"); assert.equal(f.log.filter((a) => a.method === "DELETE").length, 2);
});
test("GCP is BYOK in provider selection, sizing, capabilities, and billing", () => {
  assert.equal(sandboxOf("user-gcp"), "gcp"); assert.equal(onRuntimeComputer("user-gcp"), true); assert.equal(previewsSupported("user-gcp"), true);
  assert.deepEqual(boxSizeOn("gcp", "large", PLANS.free), { id: "large", label: "Large", cpu: 8, memoryGb: 16 });
  const settings = { sandbox: "gcp" as const, gcp: { connected: true, hint: c.project_id, updatedAt: null }, daytona: { connected: false, hint: null, updatedAt: null }, modal: { connected: false, hint: null, updatedAt: null }, boxSize: "small" as const, boxSizeChosen: false };
  const keys = { ownerId: c.user_id, gcp: async () => c, daytona: async () => null, modal: async () => null };
  assert.equal(providerForNewSessions(settings, keys).name, "user-gcp"); assert.equal(providerNamed("user-gcp", keys)?.name, "user-gcp");
  assert.throws(() => providerForNewSessions({ ...settings, gcp: undefined }, keys), NoGcpConnectionError);
  assert.equal(isLiveMeteredComputer({ projectId: "p", workspaceId: "w", status: "ready", provider: "user-gcp", updatedAt: c.created_at }, new Date()), false);
});
