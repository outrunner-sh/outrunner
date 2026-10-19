import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boxesDenial,
  exemptFromPlanLimits,
  hoursDenial,
  isLiveMeteredComputer,
  isPlanLimitError,
  liveMeteredComputers,
  type MeteredComputerRow,
  STALE_PROVISION_MS,
} from "@/lib/billing/limits";
import { PLANS } from "@/lib/billing/plans";
import type { ProviderName, RuntimeComputerStatus } from "@/lib/runtime/types";

const now = new Date("2026-10-19T12:00:00Z");
const fresh = new Date(now.getTime() - 1 * 60_000);

const box = (
  status: RuntimeComputerStatus,
  provider: ProviderName | null,
  updatedAt: string,
): MeteredComputerRow => ({ status, provider, updatedAt });

test("the plan's cloud hours are a denial only once used up", () => {
  assert.equal(hoursDenial(PLANS.free, 9.99), null);
  const denial = hoursDenial(PLANS.free, 10);
  assert.match(denial?.error ?? "", /10 cloud hours/);
  assert.equal(denial?.settingsHref, "/upgrade");
});

test("the plan's boxes are a denial only once all running", () => {
  assert.equal(boxesDenial(PLANS.free, 1), null);
  assert.match(boxesDenial(PLANS.free, 2)?.error ?? "", /2 concurrent cloud sessions/);
});

test("a live box: ready, or provisioning while fresh, and never the owner's own", () => {
  assert.equal(isLiveMeteredComputer(box("ready", null, "2026-10-01T00:00:00Z"), now), true);
  assert.equal(isLiveMeteredComputer(box("ready", "neev", fresh.toISOString()), now), true);
  assert.equal(isLiveMeteredComputer(box("provisioning", "daytona", fresh.toISOString()), now), true);
  // A claim whose provision died holds no slot forever.
  const stale = new Date(now.getTime() - STALE_PROVISION_MS - 1).toISOString();
  assert.equal(isLiveMeteredComputer(box("provisioning", "daytona", stale), now), false);
  assert.equal(isLiveMeteredComputer(box("stopped", null, fresh.toISOString()), now), false);
  // The owner's own Daytona or Modal is their bill, not the plan's.
  assert.equal(isLiveMeteredComputer(box("ready", "user-daytona", fresh.toISOString()), now), false);
  assert.equal(isLiveMeteredComputer(box("ready", "user-modal", fresh.toISOString()), now), false);
  assert.equal(
    liveMeteredComputers(
      [box("ready", null, "x"), box("ready", "user-modal", "x"), box("provisioning", "neev", fresh.toISOString())],
      now,
    ),
    2,
  );
});

test("the deployment's owners are not limited; an unset allowlist is everyone", () => {
  assert.equal(exemptFromPlanLimits({ githubLogin: "MDub3y" }, "immadsahin, MDub3y"), true);
  assert.equal(exemptFromPlanLimits({ githubLogin: "MDub3y" }, "immadsahin,sajdakabir"), false);
  // A login that never resolved cannot match a set allowlist.
  assert.equal(exemptFromPlanLimits({ githubLogin: "" }, "immadsahin"), false);
  assert.equal(exemptFromPlanLimits({ githubLogin: "anyone" }, undefined), true);
});

test("a refused claim is recognised, and only that", () => {
  assert.equal(isPlanLimitError({ code: "P4BX1", message: "no" })?.message, "no");
  assert.equal(isPlanLimitError({ code: "23505", message: "no" }), null);
  assert.equal(isPlanLimitError(new Error("no")), null);
  assert.equal(isPlanLimitError(null), null);
});
