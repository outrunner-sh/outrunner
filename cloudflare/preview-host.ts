/**
 * Previews' hosts as the Worker passes them on (worker.ts), apart so the
 * app's tests can run it under Node.
 */

/** The header naming the host a preview's request came to. */
export const PREVIEW_HOST_HEADER = "x-outrunner-preview-host";

/**
 * The request as the container gets it: one to a preview's host
 * (`<slug>.<RUNTIME_PREVIEW_DOMAIN>`) names that host, for the server's
 * preview proxy (lib/previews/proxy.ts), which the container may not see
 * as the Host; one a visitor named themselves is taken off.
 */
export function namePreviewHost(request: Request, previewDomain: string | undefined): Request {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const domain = previewDomain?.trim().toLowerCase().replace(/^\*\./, "");
  const isPreview = !!domain && hostname.endsWith(`.${domain}`);
  if (!isPreview && !request.headers.has(PREVIEW_HOST_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(PREVIEW_HOST_HEADER);
  if (isPreview) headers.set(PREVIEW_HOST_HEADER, hostname);
  return new Request(request, { headers });
}
