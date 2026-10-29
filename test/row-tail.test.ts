import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * A session row's tail answers a click with a spinner, so a click in the
 * sidebar always answers (components/sidebar-status.tsx). It goes up by the
 * app's skeleton rule and not on the click itself: a navigation that lands in
 * a few milliseconds showed one for a frame on every row clicked, a flash
 * worse than nothing (lib/session/skeleton-swap.ts).
 *
 * The rule's own timing is tested beside it (test/skeleton-swap.test.ts). What
 * can't be tested there is that this row asks for it at all — the timer lives
 * in a hook, and the repo has no renderer to run one with — so the wiring is
 * read here. A rename is fine; dropping the rule is not.
 */
test("the sidebar's row tail shows its spinner by the skeleton rule, not on the click", () => {
  const source = readFileSync(path.join(process.cwd(), "components/sidebar-status.tsx"), "utf8");
  const tail = source.slice(source.indexOf("export function RowTail"));
  assert.ok(tail, "the sidebar has a RowTail to read");

  // Not pending is ready: the load is over once the click's navigation lands.
  const decided = /const (\w+) = useSkeletonSwap\(!pending\)/.exec(tail);
  assert.ok(decided, "the tail's spinner is decided by useSkeletonSwap(!pending)");
  assert.match(tail, new RegExp(`\\{${decided[1]} && <Spinner`), "the spinner goes up only once the rule shows it");
});
