import { GCP_UUID } from "./config.ts";
/** An origin and UUID supplied by this app, with shell quoting for copy/paste. */
export function gcpSetupCommand(origin: string, ownerId?: string): string {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Outrunner origin.");
  if (ownerId && !GCP_UUID.test(ownerId)) throw new Error("Invalid Outrunner account ID.");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const base = url.origin === "https://app.outrunner.sh" ? "" : ` --url ${quote(url.origin)}`;
  return `npx outrunner@latest${base}${ownerId ? ` --account ${quote(ownerId)}` : ""} sandbox connect gcp`;
}
