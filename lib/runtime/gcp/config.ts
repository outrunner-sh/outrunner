/** Public connection metadata only: GCP access tokens are minted on demand. */
export type GcpConnection = {
  id: string;
  user_id: string;
  project_id: string;
  project_number: string;
  zone: string;
  state: "pending" | "connected" | "revoked";
  created_at: string;
  verified_at: string | null;
};
export type GcpResource = {
  id: string;
  connection_id: string;
  user_id: string;
  instance_name: string;
  instance_id: string | null;
  state: "creating" | "ready" | "stopped" | "deleting" | "deleted";
  probe: boolean;
  created_at: string;
  cleanup_attempted_at: string | null;
};
export const GCP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function checkGcpTarget(value: unknown): { projectId: string; projectNumber: string; zone: string } {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.projectId !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v.projectId)) {
    throw new Error("Choose a valid Google Cloud project ID.");
  }
  if (typeof v.projectNumber !== "string" || !/^[1-9][0-9]{4,20}$/.test(v.projectNumber)) {
    throw new Error("Google Cloud did not return a valid project number.");
  }
  if (typeof v.zone !== "string" || !/^[a-z]+-[a-z]+[0-9]+-[a-z]$/.test(v.zone)) {
    throw new Error("Choose a Google Cloud zone, such as us-central1-a.");
  }
  return { projectId: v.projectId, projectNumber: v.projectNumber, zone: v.zone };
}
export function gcpNames(c: Pick<GcpConnection, "id" | "project_id" | "project_number" | "zone">) {
  const suffix = c.id.replaceAll("-", "").slice(0, 16);
  const name = `outrunner-${suffix}`;
  const region = c.zone.replace(/-[a-z]$/, "");
  const pool = name;
  const provider = "outrunner";
  const audience = `https://iam.googleapis.com/projects/${c.project_number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
  return { name, region, pool, provider, audience, serviceAccount: `${name}@${c.project_id}.iam.gserviceaccount.com` };
}
export function gcpMachine(size = { cpu: 2, memoryGb: 4 }): string {
  if (![2, 4, 8].includes(size.cpu) || size.memoryGb !== size.cpu * 2) {
    throw new Error("Google Cloud supports Small, Medium, and Large sandboxes (2, 4, or 8 vCPU).");
  }
  return `e2-custom-${size.cpu}-${size.memoryGb * 1024}`;
}
