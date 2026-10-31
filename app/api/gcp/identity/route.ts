import { NextResponse } from "next/server";
import { gcpIssuer, gcpJwks } from "@/lib/runtime/gcp/identity";
/** Public discovery only. The CLI pins these public keys on the customer's
 * provider; assertions are minted server-side and never exposed by a route. */
export async function GET() {
  try { return NextResponse.json({ issuer: gcpIssuer(), jwks: gcpJwks() }, { headers: { "Cache-Control": "public, max-age=60" } }); }
  catch { return NextResponse.json({ error: "Google Cloud identity is not configured." }, { status: 503 }); }
}
