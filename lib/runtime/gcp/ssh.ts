import { generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import ssh2, { type Client } from "ssh2";
import type { GcpConnection, GcpResource } from "./config.ts";
import { GcpApi, gcpToken, googleJson } from "./api.ts";
import { gcpNames } from "./config.ts";
import { iapStream } from "./iap.ts";

type Session = { touchedAt: number; active: number; client: Promise<Client>; servers: Map<number, Promise<{ server: Server; url: string }>>; close(): void };
const globalStore = globalThis as { __outrunnerGcpSsh?: Map<string, Session> };
const sessions = (globalStore.__outrunnerGcpSsh ??= new Map<string, Session>());

export function closeGcpSsh(id: string) { sessions.get(id)?.close(); }
async function connect(c: GcpConnection, r: GcpResource): Promise<Client> {
  const token = await gcpToken(c);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const key = ssh2.utils.parseKey(privateKey);
  if (key instanceof Error || Array.isArray(key)) throw new Error("Could not generate a temporary SSH key.");
  const publicKey = `ssh-rsa ${key.getPublicSSH().toString("base64")} outrunner`;
  const login = await googleJson<{ loginProfile: { posixAccounts?: { username: string; operatingSystemType?: string }[] } }>(
    `https://oslogin.googleapis.com/v1/users/${encodeURIComponent(gcpNames(c).serviceAccount)}:importSshPublicKey?projectId=${c.project_id}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ key: publicKey, expirationTimeUsec: String((Date.now() + 3600_000) * 1000) }),
    }, "temporary SSH authorization");
  const account = login.loginProfile.posixAccounts?.find((a) => a.operatingSystemType === "LINUX") ?? login.loginProfile.posixAccounts?.[0];
  if (!account?.username) throw new Error("OS Login did not return a Linux account for Outrunner.");
  // Host keys are obtained through authenticated Compute API, not trusted on
  // first use from the socket. The Ubuntu guest agent publishes these at boot.
  const attrs = await new GcpApi(c).request<{ queryValue?: { items?: { key: string; value: string }[] } }>(`/zones/${c.zone}/instances/${r.instance_name}/getGuestAttributes?queryPath=hostkeys%2F`);
  const hosts = (attrs.queryValue?.items ?? []).map((item) => Buffer.from(item.value.includes(" ") ? item.value.split(" ")[1] : item.value, "base64")).filter((b) => b.length);
  if (!hosts.length) throw new Error("The VM has not published its SSH host keys yet.");
  const vm = await new GcpApi(c).request<{ id: string; labels?: Record<string, string> }>(`/zones/${c.zone}/instances/${r.instance_name}`);
  if (!r.instance_id || vm.id !== r.instance_id || vm.labels?.["outrunner-resource"] !== r.id || vm.labels?.["outrunner-connection"] !== c.id) throw new Error("The VM changed identity before SSH connected. No command was executed.");
  const socket = await iapStream({ project: c.project_id, zone: c.zone, instance: r.instance_name }, token);
  const client = new ssh2.Client();
  return new Promise((resolve, reject) => {
    client.once("ready", () => resolve(client));
    client.on("error", () => { reject(new Error("Could not establish verified SSH access to the GCP sandbox.")); socket.destroy(); });
    client.once("close", () => { socket.destroy(); reject(new Error("GCP SSH closed before becoming ready.")); });
    client.connect({ sock: socket, username: account.username, privateKey, readyTimeout: 25_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
      hostVerifier: (host: Buffer) => hosts.some((known) => host.length === known.length && timingSafeEqual(host, known)),
    });
  });
}
function session(c: GcpConnection, r: GcpResource): Session {
  let found = sessions.get(r.id);
  if (found) { found.touchedAt = Date.now(); return found; }
  const servers: Session["servers"] = new Map();
  const client = connect(c, r);
  const idle = setInterval(() => { if (found && found.active === 0 && Date.now() - found.touchedAt > 10 * 60_000) found.close(); }, 60_000);
  idle.unref();
  found = { touchedAt: Date.now(), active: 0, client, servers, close() {
    if (sessions.get(r.id) !== found) return;
    sessions.delete(r.id);
    clearInterval(idle);
    void client.then((ssh) => ssh.end(), () => {});
    for (const opened of servers.values()) void opened.then(({ server }) => { server.close(); }, () => {});
  } };
  sessions.set(r.id, found);
  void client.then((ssh) => ssh.once("close", () => { if (sessions.get(r.id) === found) found?.close(); }), () => {});
  void client.catch(() => { if (sessions.get(r.id) === found) found?.close(); });
  return found;
}
/** Script/data travel over SSH stdin, never local process arguments. */
export async function gcpExec(c: GcpConnection, r: GcpResource, command: string, input?: Buffer): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const ssh = await session(c, r).client;
  return new Promise((resolve, reject) => {
    ssh.exec(command, (error, channel) => {
      if (error) return reject(new Error("Could not execute a command in the GCP sandbox."));
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let length = 0;
      const timeout = setTimeout(() => { channel.destroy(); reject(new Error("The GCP sandbox command timed out.")); }, 120_000);
      const capture = (out: Buffer[]) => (data: Buffer) => { length += data.length; if (length > 16 * 1024 * 1024) { channel.destroy(); reject(new Error("GCP command output exceeded 16 MB.")); } else out.push(data); };
      channel.on("data", capture(stdout)); channel.stderr.on("data", capture(stderr));
      channel.on("error", () => { clearTimeout(timeout); reject(new Error("GCP SSH command disconnected.")); });
      channel.on("close", (code: number | undefined) => { clearTimeout(timeout); if (code === undefined) reject(new Error("GCP SSH closed before the command completed.")); else resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode: code }); });
      channel.end(input);
    });
  });
}
export async function gcpForward(c: GcpConnection, r: GcpResource, port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid sandbox port.");
  const s = session(c, r);
  let opened = s.servers.get(port);
  if (!opened) {
    opened = s.client.then((ssh) => new Promise<{ server: Server; url: string }>((resolve, reject) => {
      const server = createServer((socket) => {
        s.active += 1; s.touchedAt = Date.now();
        socket.once("close", () => { s.active -= 1; s.touchedAt = Date.now(); });
        ssh.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
          if (error) { socket.destroy(); return; }
          socket.on("error", () => channel.destroy()); channel.on("error", () => socket.destroy());
          socket.pipe(channel).pipe(socket); socket.on("close", () => channel.destroy()); channel.on("close", () => socket.destroy());
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    }));
    s.servers.set(port, opened);
    void opened.catch(() => s.servers.delete(port));
  }
  return (await opened).url;
}
