/**
 * What a preview may be, read from what's asked: pure, for the routes and
 * the gate (lib/previews/manage.ts, lib/previews/resolve.ts) and the tests.
 */

import type { PreviewMode } from "@/lib/db/previews";
import type { ProviderName } from "@/lib/runtime/types";

export const MAX_LABEL = 80;

/** Whether this server can reach a port on a box of `provider`'s:
 *  Daytona's preview proxy, or Neev's tunnel. Modal's and local boxes, no. */
export function previewsSupported(provider: ProviderName): boolean {
  return provider === "daytona" || provider === "user-daytona" || provider === "neev" || provider === "e2b" || provider === "user-gcp";
}

/** A label as given: trimmed, one line, 80 characters at most; null for
 *  none; undefined for one that isn't a label. */
export function previewLabel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const label = value.trim().replace(/\s+/g, " ");
  if (!label) return null;
  return label.length <= MAX_LABEL ? label : undefined;
}

/** A mode as given, or undefined for one that isn't. */
export function previewMode(value: unknown): PreviewMode | undefined {
  return value === "login" || value === "public" ? value : undefined;
}

/** A port as given (a number or its digits), or NaN. */
export function previewPort(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{1,5}$/.test(value)) return Number(value);
  return Number.NaN;
}

/**
 * The mode a body asks for: `mode` ("login" or "public"), or `authenticated`
 * (true for login, false for public) as other APIs name it. Undefined when
 * it names none; something previewMode refuses when what it names isn't one.
 */
export function askedMode(body: Record<string, unknown>): unknown {
  if (body.mode !== undefined) return body.mode;
  if (body.authenticated === true) return "login";
  if (body.authenticated === false) return "public";
  return body.authenticated === undefined ? undefined : "invalid";
}
