import { z } from "zod";

/** The faults the events stream reports, as the closed set the log accepts:
 *  the browser constructs these, so it can't invent new ones either. */
export const CLIENT_FAULT_MESSAGES = [
  "Malformed events frame payload",
  "Events frame did not match AgentEvent schema",
] as const;

/** A reported string holds one line: a field must never be able to forge the
 *  log line after the one it was given. */
const oneLine = (field: z.ZodString) =>
  field.refine((value) => !/[\r\n]/.test(value), "No line breaks");

/**
 * What a browser may report about a fault only it could see — a frame the
 * schema didn't match — keyed by the ref its Notice shows, so the code a user
 * reads out matches a server line too, not only their browser console.
 * Strictly shaped on purpose: this writes to the server's log.
 */
export const ClientFault = z.object({
  where: z.enum(["events-stream"]),
  ref: z.string().regex(/^[0-9a-f]{8}$/),
  message: z.enum(CLIENT_FAULT_MESSAGES),
  workspaceId: z.string().uuid().optional(),
  eventId: oneLine(z.string().max(120)).optional(),
  eventType: oneLine(z.string().max(60)).optional(),
  issues: z
    .array(
      z.object({
        code: oneLine(z.string().max(60)),
        // A Zod path is a few segments deep; the cap keeps a hostile one from
        // filling the log with segments the schema would never produce.
        path: z.array(z.union([oneLine(z.string().max(60)), z.number()])).max(16),
        message: oneLine(z.string().max(300)),
      }),
    )
    .max(20)
    .optional(),
});

export type ClientFault = z.infer<typeof ClientFault>;

/** The log line a report becomes. The ref leads, so the code a user reads out
 * is the thing to grep the log for. */
export function clientFaultLine(report: ClientFault): string {
  return `browser fault ${report.ref} (${report.where}): ${report.message}`;
}
