/**
 * How the public API says no: always the same envelope, whatever route or
 * part of Outrunner refused, so a client handles errors in one place.
 *
 *   { "error": { "code": "not_found", "message": "Workspace not found.", "status": 404 } }
 *
 * `code` is stable and machine-readable; `message` is a sentence for a
 * person, as the app would show it.
 */

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal";

export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; status: number; settings_url?: string };
};

/** The code a status means, where the refusal named none. */
export function codeFor(status: number): ApiErrorCode {
  if (status === 400 || status === 413 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "upstream_unavailable";
  return "internal";
}

export function apiError(
  status: number,
  message: string,
  { code = codeFor(status), settingsUrl, headers }: { code?: ApiErrorCode; settingsUrl?: string; headers?: HeadersInit } = {},
): Response {
  const body: ApiErrorBody = { error: { code, message, status, ...(settingsUrl && { settings_url: settingsUrl }) } };
  return Response.json(body, { status, headers });
}

/**
 * An app route's refusal (`{ error: "…", settingsHref? }`) in the API's
 * envelope. A route that answered with no sentence gets a plain one for its
 * status. `base` makes a settings path a link a script's user can open.
 */
export async function errorFromRoute(response: Response, base?: string): Promise<Response> {
  const data = (await response.clone().json().catch(() => null)) as { error?: unknown; settingsHref?: unknown } | null;
  const message =
    typeof data?.error === "string" && data.error
      ? data.error
      : response.status >= 500
        ? "Outrunner couldn't do that. Try again."
        : `The request was refused (${response.status}).`;
  const href = typeof data?.settingsHref === "string" ? data.settingsHref : undefined;
  const settingsUrl = href && base ? new URL(href, base).toString() : href;
  return apiError(response.status, message, { settingsUrl });
}
