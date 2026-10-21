import { z } from "zod";

/**
 * What a browser may report about a fault only it could see — a frame the
 * schema didn't match — keyed by the ref its Notice shows, so the code a user
 * reads out matches a server line too, not only their browser console.
 * Strictly shaped on purpose: this writes to the server's log.
 */
export const ClientFault = z.object({
  where: z.string().min(1).max(60),
  ref: z.string().regex(/^[0-9a-f]{8}$/),
  message: z.string().min(1).max(300),
  workspaceId: z.string().uuid().optional(),
  eventId: z.string().max(120).optional(),
  eventType: z.string().max(60).optional(),
  issues: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
});

export type ClientFault = z.infer<typeof ClientFault>;

/** The log line a report becomes. The ref leads, so the code a user reads out
 * is the thing to grep the log for. */
export function clientFaultLine(report: ClientFault): string {
  return `browser fault ${report.ref} (${report.where}): ${report.message}`;
}
