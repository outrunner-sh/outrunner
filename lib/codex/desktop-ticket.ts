import { z } from "zod";
import { open, seal } from "@/lib/crypto/secret-box";

const ticket = z.object({
  purpose: z.literal("desktop-codex-connect"),
  user: z.uuid(),
  org: z.uuid().nullable(),
  attempt: z.uuid(),
  origin: z.url(),
  expires: z.number().int(),
});
export type DesktopCodexTicket = z.infer<typeof ticket>;

/** A desktop worker may complete/cancel this attempt, never start another,
 * disconnect an account, or act as a general-purpose CLI credential. */
export function desktopCodexTicket(
  claims: Omit<DesktopCodexTicket, "purpose" | "expires">,
): string {
  return seal(
    JSON.stringify(
      ticket.parse({
        ...claims,
        purpose: "desktop-codex-connect",
        expires: Date.now() + 600_000,
      }),
    ),
  );
}

export function readDesktopCodexTicket(
  bearer: string,
  origin: string,
  now = Date.now(),
): DesktopCodexTicket {
  const claims = ticket.parse(JSON.parse(open(bearer)));
  if (claims.origin !== origin || claims.expires <= now) {
    throw new Error("Desktop connection expired.");
  }
  return claims;
}
