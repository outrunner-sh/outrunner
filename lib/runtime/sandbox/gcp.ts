import { randomUUID } from "node:crypto";
import { optionalEnv } from "@/lib/env";
// Lazy: provider selection and contract tests need no server-only database.
const findGcpResource: typeof import("@/lib/db/gcp").findGcpResource = async (...args) => (await import("@/lib/db/gcp")).findGcpResource(...args);
const gcpConnection: typeof import("@/lib/db/gcp").gcpConnection = async (...args) => (await import("@/lib/db/gcp")).gcpConnection(...args);
const recordGcpResource: typeof import("@/lib/db/gcp").recordGcpResource = async (...args) => (await import("@/lib/db/gcp")).recordGcpResource(...args);
const updateGcpResource: typeof import("@/lib/db/gcp").updateGcpResource = async (...args) => (await import("@/lib/db/gcp")).updateGcpResource(...args);
import { boxCheckScript } from "@/lib/runtime/box-image";
import { shellQuote, type BoxIO } from "@/lib/runtime/daytona/deploy";
import { GcpApi, GcpError } from "@/lib/runtime/gcp/api";
import { gcpMachine, gcpNames, type GcpConnection, type GcpResource } from "@/lib/runtime/gcp/config";
import { gcpExec, gcpForward, closeGcpSsh } from "@/lib/runtime/gcp/ssh";
import { gcpStartupScript } from "@/lib/runtime/gcp/startup";
import { GCP_RELAY_PREFIX, gcpRelayTicket } from "@/lib/runtime/gcp/relay-ticket";
import type { BoxResources, SandboxBackend, SandboxBox } from "./backend.ts";

class GcpImageError extends Error { constructor() { super("The GCP sandbox image failed its pinned tool verification. Recreate the sandbox with the current image."); } }

type Instance = { id: string; status: string; labels?: Record<string, string>; machineType?: string };
const SHELL = "sudo -n docker exec -i --user runtime outrunner-workspace bash -s";
export function gcpInstanceBody(c: GcpConnection, r: GcpResource, size: BoxResources = { cpu: 2, memoryGb: 4 }) {
  const n = gcpNames(c);
  return {
    name: r.instance_name, machineType: `zones/${c.zone}/machineTypes/${gcpMachine(size)}`,
    labels: { "outrunner-role": "sandbox", "outrunner-connection": c.id, "outrunner-resource": r.id },
    tags: { items: [n.name] },
    disks: [{ boot: true, autoDelete: true, type: "PERSISTENT", initializeParams: { diskName: r.instance_name, labels: { "outrunner-connection": c.id, "outrunner-resource": r.id }, diskSizeGb: "50", diskType: `zones/${c.zone}/diskTypes/pd-balanced`, sourceImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64" } }],
    networkInterfaces: [{ subnetwork: `projects/${c.project_id}/regions/${n.region}/subnetworks/${n.name}`, accessConfigs: [] }],
    serviceAccounts: [],
    metadata: { items: [
      { key: "enable-oslogin", value: "TRUE" }, { key: "enable-guest-attributes", value: "TRUE" },
      { key: "block-project-ssh-keys", value: "TRUE" }, { key: "startup-script", value: gcpStartupScript() },
    ] },
    shieldedInstanceConfig: { enableVtpm: true, enableIntegrityMonitoring: true },
  };
}
export function assertGcpOwnership(c: GcpConnection, r: GcpResource, vm: Instance) {
  if (r.connection_id !== c.id || r.user_id !== c.user_id || vm.labels?.["outrunner-connection"] !== c.id || vm.labels?.["outrunner-resource"] !== r.id || (r.instance_id && r.instance_id !== vm.id)) {
    throw new Error("The GCP VM's identity does not match this Outrunner sandbox. No action was taken.");
  }
}
const defaultGcpDeps = {
  find: findGcpResource, connection: gcpConnection, record: recordGcpResource, update: updateGcpResource,
  exec: gcpExec, forward: gcpForward, close: closeGcpSsh, api: (c: GcpConnection) => new GcpApi(c),
  now: Date.now, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
export type GcpBackendDeps = typeof defaultGcpDeps;
export class GcpBackend implements SandboxBackend {
  private readonly deps: GcpBackendDeps;
  private readonly ownerId: string;
  private readonly connection: () => Promise<GcpConnection | null>;
  private readonly probe: boolean;
  constructor(ownerId: string, connection: () => Promise<GcpConnection | null>, probe = false, deps: Partial<GcpBackendDeps> = {}) {
    this.deps = { ...defaultGcpDeps, ...deps };
    this.ownerId = ownerId; this.connection = connection; this.probe = probe;
  }
  private async target(id: string) {
    if (!this.ownerId) throw new Error("A Google Cloud sandbox needs its session owner.");
    const resource = await this.deps.find(id, this.ownerId);
    const connection = await this.deps.connection(this.ownerId, resource.connection_id);
    if (!connection) throw new Error("The Google Cloud connection for this session is no longer available.");
    return { c: connection, r: resource, api: this.deps.api(connection) };
  }
  private path(c: GcpConnection, r: GcpResource) { return `/zones/${c.zone}/instances/${r.instance_name}`; }
  private async instance(c: GcpConnection, r: GcpResource, api: GcpApi): Promise<Instance> {
    const vm = await api.request<Instance>(this.path(c, r));
    assertGcpOwnership(c, r, vm); return vm;
  }
  async create(_labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const c = await this.connection();
    if (!c || c.user_id !== this.ownerId || (c.state !== "connected" && !this.probe)) throw new Error("Connect Google Cloud using outrunner sandbox connect gcp.");
    gcpMachine(size); // Fail before recording anything for unsupported resources.
    const r = await this.deps.record(c, this.probe);
    const api = this.deps.api(c);
    let accepted = false;
    try {
      const operation = await api.request<{ name: string }>(`/zones/${c.zone}/instances?requestId=${randomUUID()}`, "POST", gcpInstanceBody(c, r, size));
      accepted = true;
      await api.wait(operation);
      const vm = await this.instance(c, r, api);
      await this.deps.update(r.id, { instance_id: vm.id }); r.instance_id = vm.id;
      await this.ready(c, r);
      await this.deps.update(r.id, { state: "ready" });
      return this.box(c, r, vm);
    } catch (error) {
      // Intent was recorded before insert. If the operation is still running,
      // cleanup leaves a deleting ledger row for the cron to retry safely.
      if (!accepted && error instanceof GcpError && error.status >= 400 && error.status < 500 && error.status !== 408) await this.deps.update(r.id, { state: "deleted" });
      else await this.delete(r.id).catch(() => {});
      throw error;
    }
  }
  private async ready(c: GcpConnection, r: GcpResource, checkImage = true) {
    const deadline = this.deps.now() + 8 * 60_000;
    while (this.deps.now() < deadline) {
      try {
        const boot = await this.deps.exec(c, r, "sudo -n test -f /var/lib/outrunner/ready && sudo -n docker inspect --format '{{.State.Running}}' outrunner-workspace | grep -qx true");
        if (boot.exitCode === 0) {
          if (!checkImage) return; // Shared deploy upgrades pinned tools on restored disks.
          const checked = await this.deps.exec(c, r, SHELL, Buffer.from(boxCheckScript()));
          if (checked.exitCode !== 0) throw new GcpImageError();
          return;
        }
      } catch (error) {
        this.deps.close(r.id);
        if (error instanceof GcpImageError || (error instanceof GcpError && [401, 403].includes(error.status))) throw error;
      }
      await this.deps.sleep(4000);
    }
    throw new Error("The GCP VM did not finish startup within eight minutes. Check /var/log/outrunner-startup.log in Google Cloud; Outrunner will clean up its recorded VM.");
  }
  async get(id: string): Promise<SandboxBox> {
    const { c, r, api } = await this.target(id);
    const vm = await this.instance(c, r, api);
    if (vm.status !== "RUNNING") throw new Error("The GCP sandbox is stopped. Open its session to restore it.");
    return this.box(c, r, vm);
  }
  async alive(id: string): Promise<boolean> {
    const { c, r, api } = await this.target(id);
    try { return (await this.instance(c, r, api)).status === "RUNNING"; }
    catch (error) { if (error instanceof GcpError && error.status === 404) return false; throw error; }
  }
  async pause(id: string): Promise<void> {
    const { c, r, api } = await this.target(id);
    const vm = await this.instance(c, r, api);
    this.deps.close(id);
    if (vm.status !== "TERMINATED") await api.wait(await api.request(`${this.path(c, r)}/stop`, "POST"));
    await this.deps.update(id, { state: "stopped" });
  }
  async restore(id: string): Promise<SandboxBox | null> {
    const { c, r, api } = await this.target(id);
    let vm: Instance;
    try { vm = await this.instance(c, r, api); }
    catch (error) { if (error instanceof GcpError && error.status === 404) return null; throw error; }
    this.deps.close(id);
    if (vm.status === "TERMINATED") await api.wait(await api.request(`${this.path(c, r)}/start`, "POST"));
    else if (vm.status !== "RUNNING") throw new Error(`The GCP sandbox is ${vm.status}. Wait for its current operation to finish.`);
    try {
      await this.ready(c, r, false);
      vm = await this.instance(c, r, api);
      await this.deps.update(id, { state: "ready" });
      return this.box(c, r, vm);
    } catch (error) { await this.pause(id).catch(() => {}); throw error; }
  }
  async delete(id: string): Promise<void> {
    const { c, r, api } = await this.target(id);
    if (r.state === "deleted") return;
    this.deps.close(id);
    await this.deps.update(id, { state: "deleting" });
    try {
      await this.instance(c, r, api);
      await api.wait(await api.request(this.path(c, r), "DELETE"));
    } catch (error) {
      if (!(error instanceof GcpError && error.status === 404)) throw error;
      // A pending insert may not be visible yet. Keep retrying that intent
      // through its grace period instead of forgetting a VM that appears late.
      if (!r.instance_id && this.deps.now() - Date.parse(r.created_at) < 2 * 3600_000) throw new Error("GCP creation is still being settled; cleanup will retry.");
    }
    // A customer can detach a disk or disable auto-delete. Remove only the
    // boot disk recorded for this resource, after checking its own labels.
    const diskPath = `/zones/${c.zone}/disks/${r.instance_name}`;
    try {
      const disk = await api.request<{ labels?: Record<string, string> }>(diskPath);
      if (disk.labels?.["outrunner-connection"] !== c.id || disk.labels?.["outrunner-resource"] !== r.id) throw new Error("The remaining disk does not belong to this GCP sandbox. It was left untouched.");
      await api.wait(await api.request(diskPath, "DELETE"));
    } catch (error) { if (!(error instanceof GcpError && error.status === 404)) throw error; }
    await this.deps.update(id, { state: "deleted" });
  }
  private box(c: GcpConnection, r: GcpResource, vm: Instance): SandboxBox {
    const run = (script: string) => this.deps.exec(c, r, SHELL, Buffer.from(script));
    const io: BoxIO = {
      exec: run,
      launch: async (script) => { const result = await run(script); if (result.exitCode) throw new Error("Could not launch the GCP runtime-agent."); },
      upload: async (data, path) => {
        const result = await this.deps.exec(c, r, `sudo -n docker exec -i --user runtime outrunner-workspace bash -c ${shellQuote(`umask 077; mkdir -p -- "$(dirname -- ${shellQuote(path)})"; cat > ${shellQuote(path)}`)}`, data);
        if (result.exitCode) throw new Error("Could not upload the GCP runtime-agent.");
      },
    };
    const cpu = Number(vm.machineType?.match(/e2-custom-(\d+)-/)?.[1]);
    return { id: r.id, io, cpu: cpu || undefined, home: async () => "/home/runtime",
      gitExec: (argv, options) => {
        const env = Object.entries(options?.env ?? {}).map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid process environment name.");
          return `export ${key}=${shellQuote(value)}`;
        });
        return run([...env, argv.map(shellQuote).join(" ")].join("\n"));
      },
      agentEndpoint: async (port) => ({ controlBaseUrl: await this.deps.forward(c, r, port), controlHeaders: {}, wsBaseUrl: `${optionalEnv("RUNTIME_BASE_URL")}${GCP_RELAY_PREFIX}${r.id}/${port}/${gcpRelayTicket(r.id, port)}` }),
      previewTarget: async (port) => ({ baseUrl: await this.deps.forward(c, r, port), headers: {}, hostHeader: "preview" }),
    };
  }
}
