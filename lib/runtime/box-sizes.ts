/**
 * How big a new Outrunner sandbox is (Settings → Sandbox). Outrunner pays for
 * these, so the larger sizes are for a higher plan, which doesn't exist yet:
 * they're shown, locked, and refused if asked for. Neev's ceiling is 8 vCPU
 * and 16 GB. Imports nothing, so the settings page can use it as is.
 */

export type BoxSizeId = "x-small" | "small" | "medium" | "large";

export type BoxSize = {
  id: BoxSizeId;
  label: string;
  cpu: number;
  memoryGb: number;
  /** Needs a higher plan. */
  locked?: true;
};

export const BOX_SIZES: readonly BoxSize[] = [
  { id: "x-small", label: "X Small", cpu: 1, memoryGb: 2 },
  { id: "small", label: "Small", cpu: 2, memoryGb: 4 },
  { id: "medium", label: "Medium", cpu: 4, memoryGb: 8 },
  { id: "large", label: "Large", cpu: 8, memoryGb: 16, locked: true },
];

export const DEFAULT_BOX_SIZE: BoxSizeId = "small";

export function isBoxSizeId(value: unknown): value is BoxSizeId {
  return BOX_SIZES.some((size) => size.id === value);
}

/** The size by id; the default for one this build doesn't know. */
export function boxSize(id: string): BoxSize {
  return BOX_SIZES.find((size) => size.id === id) ?? boxSize(DEFAULT_BOX_SIZE);
}
