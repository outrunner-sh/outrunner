import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { clientFaultLine, ClientFault } from "@/lib/http/client-error-report";
import { isSameOriginRequest } from "@/lib/http/guards";

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
  // (The header can be absent behind a proxy — then the schema is the bound.)
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > 8 * 1024) {
    return NextResponse.json({ error: "Malformed report." }, { status: 400 });
  }
  const report = ClientFault.safeParse(await request.json().catch(() => null));
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
