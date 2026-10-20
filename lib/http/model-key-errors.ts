import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { StoredKeyUnreadableError } from "@/lib/openrouter/user-key";
import { NoProviderKeyError } from "@/lib/providers/errors";

/**
 * The answer to a failure to get the key a model runs on, for every route that
 * gets one (a local session's key, a cloud session's switch). The user's
 * messages pass through; anything else stays in the log under `context`.
 * A plain Response, which route handlers return as they do NextResponse, so
 * it tests without Next.
 */
export function modelKeyErrorResponse(error: unknown, context: string): Response {
  // Not set up here, or a stored key no one can read: not the user's to fix.
  if (error instanceof OutrunnerModelsUnavailableError || error instanceof StoredKeyUnreadableError) {
    return Response.json({ error: error.message }, { status: 503 });
  }
  // The user has something to change; the message says what, and where.
  if (error instanceof NoProviderKeyError) {
    return Response.json({ error: error.message, settingsHref: error.settingsHref }, { status: 409 });
  }
  if (error instanceof ModelKeyRefusedError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  // OpenRouter's and the driver's messages stay in the log.
  console.error(context, error);
  return Response.json({ error: "Outrunner's models are unavailable right now. Please try again." }, { status: 502 });
}
