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
  boxLive,
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
  projectId = "p-1",
  workspaceId: string | null = null,
): MeteredComputerRow => ({ projectId, workspaceId, status, provider, updatedAt });

test("the plan's cloud hours are a denial only once used up", () => {
  assert.equal(hoursDenial(PLANS.free, 9.99), null);
  const denial = hoursDenial(PLANS.free, 10);
  assert.match(denial?.error ?? "", /10 cloud hours/);
  assert.equal(denial?.settingsHref, "/upgrade");
});

test("the plan's boxes are a denial only once all running", () => {
  assert.equal(boxesDenial(PLANS.free, 9), null);
  assert.match(boxesDenial(PLANS.free, 10)?.error ?? "", /10 concurrent cloud sessions/);
});

// Keep these boundaries aligned with schema assertion 20's SQL count checks.
test("a live box: ready, or provisioning while fresh, and never the owner's own", () => {
  assert.equal(isLiveMeteredComputer(box("ready", null, "2026-10-01T00:00:00Z"), now), true);
  assert.equal(isLiveMeteredComputer(box("ready", "neev", fresh.toISOString()), now), true);
  assert.equal(isLiveMeteredComputer(box("provisioning", "daytona", fresh.toISOString()), now), true);
  // A claim whose provision died holds no slot forever.
  const stale = new Date(now.getTime() - STALE_PROVISION_MS - 1).toISOString();
  assert.equal(isLiveMeteredComputer(box("provisioning", "daytona", stale), now), false);
  assert.equal(isLiveMeteredComputer(box("stopped", null, fresh.toISOString()), now), false);
  // An ordinary pooled box runs no one's session; a short intent-warm lease
  // consumes the slot that Send will inherit.
  assert.equal(isLiveMeteredComputer({ ...box("provisioning", "daytona", fresh.toISOString()), pooled: true }, now), false);
  assert.equal(
    isLiveMeteredComputer(
      { ...box("provisioning", "daytona", fresh.toISOString()), pooled: true, warmExpiresAt: fresh.toISOString() },
      now,
    ),
    true,
  );
  assert.equal(
    isLiveMeteredComputer(
      { ...box("ready", "daytona", fresh.toISOString()), pooled: true, warmExpiresAt: fresh.toISOString() },
      now,
    ),
    true,
  );
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

// The gate's box count refuses only a session that would start a box: one
// whose box is live runs on it.
test("a session's box is live only when that box is", () => {
  const boxes = [
    box("ready", null, "x", "p-1"),
    box("ready", null, "x", "p-2", "w-own"),
    box("provisioning", "neev", fresh.toISOString(), "p-3"),
  ];
  // A project's shared box from before, for the sessions still on it.
  assert.equal(boxLive(boxes, { projectId: "p-1" }, now), true);
  assert.equal(boxLive(boxes, { projectId: "p-3" }, now), true);
  // A session's own box.
  assert.equal(boxLive(boxes, { workspaceId: "w-own" }, now), true);
  assert.equal(boxLive(boxes, { workspaceId: "w-other" }, now), false);
  // A workspace's own box is not its project's shared one, nor the reverse.
  assert.equal(boxLive(boxes, { projectId: "p-2" }, now), false);
  // A new session always starts a box.
  assert.equal(boxLive(boxes, null, now), false);
  // Except one with a live intent-warmed box reserved for its project.
  const intent = {
    ...box("ready", "daytona", fresh.toISOString(), "p-warm"),
    pooled: true,
    warmExpiresAt: fresh.toISOString(),
  };
  assert.equal(boxLive([intent], { warmProjectId: "p-warm" }, now), true);
  assert.equal(boxLive([intent], { warmProjectId: "p-other" }, now), false);
  // Its box paused, or its provision died: the session starts one.
  assert.equal(boxLive([box("stopped", null, "x", "p-1", "w-1")], { workspaceId: "w-1" }, now), false);
  const stale = new Date(now.getTime() - STALE_PROVISION_MS - 1).toISOString();
  assert.equal(boxLive([box("provisioning", null, stale, "p-1")], { projectId: "p-1" }, now), false);
});

test("only explicitly configured plan-limit exemptions are exempt", () => {
  assert.equal(exemptFromPlanLimits({ githubLogin: "MDub3y" }, "immadsahin, MDub3y"), true);
  assert.equal(exemptFromPlanLimits({ githubLogin: "MDub3y" }, "immadsahin,sajdakabir"), false);
  // A login that never resolved cannot match a set allowlist.
  assert.equal(exemptFromPlanLimits({ githubLogin: "" }, "immadsahin"), false);
  // Open sign-up is separate from exemptions: an unset list exempts nobody.
  assert.equal(exemptFromPlanLimits({ githubLogin: "anyone" }, undefined), false);
});

test("a refused claim is recognised, and only that", () => {
  assert.equal(isPlanLimitError({ code: "P4BX1", message: "no" })?.message, "no");
  assert.equal(isPlanLimitError({ code: "23505", message: "no" }), null);
  assert.equal(isPlanLimitError(new Error("no")), null);
  assert.equal(isPlanLimitError(null), null);
});

test("Max can start past the old 500-hour cap, while its concurrent-box cap still applies", () => {
  for (const used of [500, 501, 100000]) assert.equal(hoursDenial(PLANS.max, used), null);
  assert.ok(boxesDenial(PLANS.max, 50));
});
