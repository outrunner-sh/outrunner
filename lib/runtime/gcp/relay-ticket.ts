import { createHmac } from "node:crypto";
import { mintRelayTicket } from "../sandbox/neev-relay-ticket.ts";
export const GCP_RELAY_PREFIX = "/relay/gcp/";
export function gcpRelayKey(key: string): string { return createHmac("sha256", key).update("outrunner:gcp-relay:v1").digest("base64url"); }
export function gcpRelayTicket(id: string, port: number): string {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) throw new Error("GCP relay signing is not configured.");
  return mintRelayTicket(id, port, gcpRelayKey(key));
}
