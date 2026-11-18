/**
 * The cost basis a Mission's model calls are estimated on when no provider
 * reported their cost (docs/mission-spend.md): list prices per million
 * tokens, versioned, so an estimate always says what it was priced on. An
 * estimate, never an invoice: a call on a Claude subscription or the owner's
 * own key costs what that account's terms say; this is what the tokens would
 * cost at list price. A model it doesn't list is priced at nothing: its cost
 * is unavailable, never $0. Pure apart from reading the optional
 * MISSION_COST_BASIS extension.
 */

import { z } from "zod";

import { optionalEnv } from "@/lib/env";

/** USD per million tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  /** Cache writes at the 5-minute rate (1.25× input); a write the log says
   *  went to the 1-hour cache is 2× input. */
  cacheWrite: number;
  cacheRead: number;
  /** A higher rate for prompts over `aboveTokens` (input, cached or not). */
  longContext?: { aboveTokens: number; input: number; output: number; cacheWrite: number; cacheRead: number };
};

export type CostBasis = { version: string; models: Record<string, ModelPrice> };

/** A call's tokens, as its log says them. */
export type CallTokens = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** The 1-hour cache's part of cache_creation_input_tokens, where the log
   *  says it: 2× input, not the 5-minute 1.25×. */
  cache_creation_1h_input_tokens?: number;
};

/** A 1-hour cache write, as a multiple of input. */
const ONE_HOUR_WRITE = 2;

/** Fast mode's prices, as a multiple of the model's standard ones. */
const FAST = 2;

const price = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead,
});

/**
 * Anthropic's first-party list prices, as of the version's date. Cache reads
 * where the price list states them, else 0.1× input. A change of any price is
 * a new version: rows keep the version they were priced on.
 */
export const BUILTIN_COST_BASIS: CostBasis = {
  version: "anthropic-list-2026-11-18",
  models: {
    "claude-fable-5-2": price(8, 40, 0.2),
    "claude-mythos-5-2": price(8, 40, 0.2),
    "claude-fable-5-1": price(10, 50, 0.25),
    "claude-mythos-5-1": price(10, 50, 0.25),
    "claude-fable-5": price(10, 50, 1),
    "claude-opus-5-5": price(4, 20, 0.2),
    "claude-opus-5": price(5, 25, 0.5),
    "claude-opus-4-8": price(5, 25, 0.5),
    "claude-opus-4-7": price(5, 25, 0.5),
    "claude-opus-4-6": price(5, 25, 0.5),
    "claude-sonnet-5-5": price(2, 10, 0.2),
    "claude-sonnet-5": price(2, 10, 0.2),
    "claude-sonnet-4-6": price(3, 15, 0.3),
    "claude-haiku-5-5": {
      ...price(0.1, 0.5, 0.01),
      longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
    },
    "claude-haiku-4-5": price(1, 5, 0.1),
  },
};

const Price = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
});
const Extension = z.object({
  version: z.string().trim().min(1).max(60),
  models: z.record(z.string().min(1), Price),
});

/**
 * MISSION_COST_BASIS, the deployment's prices for models the built-in basis
 * doesn't list (Outrunner's OpenRouter models, Codex's): null when unset, or
 * set wrong (logged, so nothing is priced on a basis no one meant).
 */
export function costBasisExtension(raw: string | undefined = optionalEnv("MISSION_COST_BASIS")): CostBasis | null {
  if (!raw?.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error("MISSION_COST_BASIS isn't JSON: its models stay unpriced.");
    return null;
  }
  const parsed = Extension.safeParse(json);
  if (!parsed.success) {
    console.error("MISSION_COST_BASIS isn't {version, models: {id: {input, output}}}: its models stay unpriced.");
    return null;
  }
  const models: Record<string, ModelPrice> = {};
  for (const [id, p] of Object.entries(parsed.data.models)) {
    models[id.trim().toLowerCase()] = {
      input: p.input,
      output: p.output,
      cacheWrite: p.cacheWrite ?? p.input,
      cacheRead: p.cacheRead ?? p.input,
    };
  }
  return { version: parsed.data.version, models };
}

/**
 * The name a model is priced under: as the log says it, lower-cased; for
 * Claude, without an OpenRouter-style `anthropic/` prefix, a `[1m]` context
 * marker or a date suffix, and with dots as dashes (`claude-sonnet-5.5`).
 */
export function pricedModelName(model: string): string {
  let name = model.trim().toLowerCase().replace(/\[1m\]$/, "");
  if (name.startsWith("anthropic/")) name = name.slice("anthropic/".length);
  if (name.startsWith("claude-")) name = name.replace(/\./g, "-").replace(/-\d{8}$/, "");
  return name;
}

export type Estimate = { usd: number; basis: string };

/**
 * What a call's tokens cost on the basis: the deployment's extension first
 * (by the model's exact name, then its priced name), then the built-in list.
 * Null when neither lists the model: unpriced, not free.
 */
export function estimateCall(
  model: string | null | undefined,
  tokens: CallTokens,
  extension: CostBasis | null = costBasisExtension(),
  speed?: string,
): Estimate | null {
  if (!model) return null;
  const exact = model.trim().toLowerCase();
  const name = pricedModelName(model);
  const found =
    (extension && (extension.models[exact] ?? extension.models[name]) && {
      price: extension.models[exact] ?? extension.models[name],
      basis: extension.version,
    }) ||
    (BUILTIN_COST_BASIS.models[name] && { price: BUILTIN_COST_BASIS.models[name], basis: BUILTIN_COST_BASIS.version }) ||
    null;
  if (!found) return null;
  const prompt = tokens.input_tokens + tokens.cache_creation_input_tokens + tokens.cache_read_input_tokens;
  const p = found.price.longContext && prompt > found.price.longContext.aboveTokens ? found.price.longContext : found.price;
  const oneHour = Math.min(tokens.cache_creation_1h_input_tokens ?? 0, tokens.cache_creation_input_tokens);
  const usd =
    ((tokens.input_tokens * p.input +
      tokens.output_tokens * p.output +
      (tokens.cache_creation_input_tokens - oneHour) * p.cacheWrite +
      oneHour * p.input * ONE_HOUR_WRITE +
      tokens.cache_read_input_tokens * p.cacheRead) *
      (speed === "fast" ? FAST : 1)) /
    1_000_000;
  return { usd: roundUsd(usd), basis: found.basis };
}

/** To the 1e-8 dollar the database keeps. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}
