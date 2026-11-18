import { mintRelayTicket, relayKey } from "../sandbox/relay-ticket.ts";
export const GCP_RELAY_PREFIX = "/relay/gcp/";
export function gcpRelayKey(key: string): string { return relayKey(key, "gcp"); }
export function gcpRelayTicket(id: string, port: number): string {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) throw new Error("GCP relay signing is not configured.");
  return mintRelayTicket(id, port, gcpRelayKey(key));
}
