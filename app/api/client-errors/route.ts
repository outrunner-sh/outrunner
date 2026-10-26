import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { readCappedBody } from "@/lib/http/capped-body";
import { clientFaultLine, ClientFault } from "@/lib/http/client-error-report";
import { isSameOriginRequest } from "@/lib/http/guards";

/** The body bound: well above any report we send, well below anything worth
 *  buffering. The schema's own field caps sit inside it. */
const MAX_REPORT_BYTES = 8 * 1024;

/**
 * Where a browser reports a fault only it could see: a frame that didn't
 * match the protocol. The ref its Notice shows reaches the server's log here,
 * so support can find the report a user quotes — until now the ref lived only
 * in the browser console.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  // A report is a few known fields: one bigger than any we send isn't ours.
  // The read itself is capped (readCappedBody): the header is only a shortcut,
  // since a proxy may drop it and a chunked body omits it, so a body past the
  // cap is refused without being read into memory.
  const raw = await readCappedBody(request, MAX_REPORT_BYTES);
  if (raw === null) {
    return NextResponse.json({ error: "Malformed report." }, { status: 400 });
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The schema reports it as malformed, the same as any other bad shape.
  }
  const report = ClientFault.safeParse(parsed);
  if (!report.success) {
    return NextResponse.json({ error: "Malformed report." }, { status: 400 });
  }
  // Context after the line, ref before the fold: the log is grepped by ref.
  // The owner's id says whose session faulted it; a ref alone traces nowhere.
  console.error(clientFaultLine(report.data), {
    ownerId: owner.id,
    workspaceId: report.data.workspaceId,
    eventId: report.data.eventId,
    eventType: report.data.eventType,
    issues: report.data.issues,
  });
  return new NextResponse(null, { status: 204 });
}
