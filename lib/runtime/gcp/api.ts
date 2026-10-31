import { createHash } from "node:crypto";
import { gcpNames, type GcpConnection } from "./config.ts";
import { gcpAssertion } from "./identity.ts";

export class GcpError extends Error {
  readonly status: number;
  constructor(status: number, action: string) {
    // Never echo Google's response body: STS errors can include assertions.
    super(`Google Cloud refused ${action} (HTTP ${status}). Check billing, quotas, APIs, and the Outrunner service account's permissions; rerun sandbox connect gcp if its access changed.`);
    this.name = "GcpError";
    this.status = status;
  }
}
export async function googleJson<T>(url: string, init: RequestInit, action: string): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new GcpError(response.status, action);
  return (response.status === 204 ? {} : await response.json()) as T;
}
const tokens = new Map<string, { value: string; expires: number }>();
export async function gcpToken(c: GcpConnection): Promise<string> {
  if (c.state === "revoked") throw new Error("Google Cloud connection disconnected.");
  const key = `${c.id}:${gcpAssertionKey()}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const n = gcpNames(c);
  const exchanged = await googleJson<{ access_token: string }>("https://sts.googleapis.com/v1/token", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      // STS expects a resource name; the JWT retains the configured HTTPS audience.
      audience: n.audience.replace(/^https:/, ""), grantType: "urn:ietf:params:oauth:grant-type:token-exchange", requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      scope: "https://www.googleapis.com/auth/cloud-platform", subjectTokenType: "urn:ietf:params:oauth:token-type:jwt", subjectToken: gcpAssertion(c),
    }),
  }, "workload identity authentication");
  if (typeof exchanged.access_token !== "string" || !exchanged.access_token) throw new Error("Google Cloud did not return a valid federation token.");
  const token = await googleJson<{ accessToken: string; expireTime: string }>(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${n.serviceAccount}:generateAccessToken`, {
      method: "POST", headers: { authorization: `Bearer ${exchanged.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "3600s" }),
    }, "service account impersonation");
  if (typeof token.accessToken !== "string" || !token.accessToken || !Number.isFinite(Date.parse(token.expireTime))) throw new Error("Google Cloud did not return a valid service account token.");
  for (const [id, value] of tokens) if (value.expires <= Date.now()) tokens.delete(id);
  tokens.set(key, { value: token.accessToken, expires: Date.parse(token.expireTime) });
  return token.accessToken;
}
// A rotated signing key must not reuse a previous identity's access token.
function gcpAssertionKey() { return createHash("sha256").update(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "").digest("hex"); }
export class GcpApi {
  readonly connection: GcpConnection;
  constructor(connection: GcpConnection) { this.connection = connection; }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.includes("..")) throw new Error("Invalid Compute Engine API path.");
    const token = await gcpToken(this.connection);
    return googleJson<T>(`https://compute.googleapis.com/compute/v1/projects/${this.connection.project_id}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }),
    }, "sandbox management");
  }
  async wait(operation: { name: string; status?: string; error?: unknown; zone?: string }) {
    const deadline = Date.now() + 8 * 60_000;
    let current = operation;
    while (current.status !== "DONE") {
      if (Date.now() > deadline) throw new Error("Google Cloud did not finish the sandbox operation within eight minutes. Its recorded resource will be reconciled.");
      await new Promise((r) => setTimeout(r, 1000));
      current = await this.request(`/zones/${this.connection.zone}/operations/${operation.name}`);
    }
    if (current.error) throw new Error("Google Cloud could not finish the sandbox operation. Check the project's operation log for quota, capacity, or permission errors.");
  }
}

/** Check effective grants before incurring a VM charge. New IAM bindings can
 * take time to propagate even after gcloud has finished writing them. */
export async function checkGcpAccess(c: GcpConnection) {
  const permissions = ["compute.instances.create", "compute.instances.delete", "compute.instances.start", "compute.instances.stop", "compute.instances.getGuestAttributes", "compute.instances.osAdminLogin", "iap.tunnelInstances.accessViaIAP"];
  const token = await gcpToken(c);
  const granted = await googleJson<{ permissions?: string[] }>(`https://cloudresourcemanager.googleapis.com/v1/projects/${c.project_id}:testIamPermissions`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ permissions }),
  }, "sandbox permission verification");
  if (permissions.some((p) => !granted.permissions?.includes(p))) throw new GcpError(403, "sandbox permission verification");
}
