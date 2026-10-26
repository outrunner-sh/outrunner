/**
 * Where a menu fits beside its trigger, by the numbers alone, so the rule is
 * tested without a page (the repository picker measures them).
 */

/** Where the menu opens: below the trigger or above it, and the most height it
 *  has there (none until measured). */
export type Placement = { side: "below" | "above"; maxHeight?: number };

/** The space between the trigger and the menu, and the menu and an edge. */
export const MENU_GAP = 8;

/**
 * Below, unless below hasn't room for the whole menu (`wanted` tall) and above
 * has more; as tall as the room on that side. `trigger` and `room` are top and
 * bottom edges on the screen: the trigger's, and those of what can be seen.
 */
export function placeMenu(
  trigger: { top: number; bottom: number },
  room: { top: number; bottom: number },
  wanted: number,
): Placement {
  const below = room.bottom - trigger.bottom - 2 * MENU_GAP;
  const above = trigger.top - room.top - 2 * MENU_GAP;
  const side = below >= wanted || below >= above ? "below" : "above";
  return { side, maxHeight: Math.max(0, side === "below" ? below : above) };
}
