/**
 * Previews' hosts as the Worker passes them on (worker.ts), apart so the
 * app's tests can run it under Node.
 */

/** The header naming the host a preview's request came to, and the one
 *  proving the Worker named it. */
export const PREVIEW_HOST_HEADER = "x-outrunner-preview-host";
export const PREVIEW_HOST_SIGNATURE_HEADER = "x-outrunner-preview-host-signature";

/**
 * The signature of a host the Worker names: HMAC-SHA256, keyed by
 * CREDENTIALS_ENCRYPTION_KEY (which the Worker holds and hands the
 * container), over its purpose and the host, base64url. The server checks
 * it with lib/previews/tokens.ts edgeHostSignature, which must match.
 */
export async function signPreviewHost(credentialsKey: string, host: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(credentialsKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`outrunner preview host\n${host}`)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The request as the container gets it: one to a preview's host
 * (`<slug>.<RUNTIME_PREVIEW_DOMAIN>`) names that host, signed, for the
 * server's preview proxy (lib/previews/proxy.ts), which the container may
 * not see as the Host; a name or signature a visitor sent is taken off.
 * Without the key nothing is named, and the proxy goes by the Host.
 */
export async function namePreviewHost(
  request: Request,
  previewDomain: string | undefined,
  credentialsKey: string | undefined,
): Promise<Request> {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const domain = previewDomain?.trim().toLowerCase().replace(/^\*\./, "");
  const isPreview = !!domain && !!credentialsKey && hostname.endsWith(`.${domain}`);
  if (!isPreview && !request.headers.has(PREVIEW_HOST_HEADER) && !request.headers.has(PREVIEW_HOST_SIGNATURE_HEADER)) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete(PREVIEW_HOST_HEADER);
  headers.delete(PREVIEW_HOST_SIGNATURE_HEADER);
  if (isPreview) {
    headers.set(PREVIEW_HOST_HEADER, hostname);
    headers.set(PREVIEW_HOST_SIGNATURE_HEADER, await signPreviewHost(credentialsKey, hostname));
  }
  return new Request(request, { headers });
}
