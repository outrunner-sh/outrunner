"use client";

import { useState } from "react";

import { activeIndexOf, stepIndex } from "@/lib/nav/active-option";

/**
 * The option the arrow keys are on in a combobox list (focus stays in the
 * search field, and this one is announced as active), followed by its key
 * through changes to the list (lib/nav/active-option.ts).
 */
export function useActiveOption<T, K>(items: readonly T[], keyOf: (item: T) => K) {
  const [activeKey, setActiveKey] = useState<K | null>(null);
  const activeIndex = activeIndexOf(items, keyOf, activeKey);
  return {
    /** -1 for an empty list. */
    activeIndex,
    active: activeIndex === -1 ? null : items[activeIndex],
    /** Move by `step` options, wrapping round. */
    move(step: number) {
      const next = stepIndex(items.length, activeIndex, step);
      if (next !== -1) setActiveKey(keyOf(items[next]));
    },
    setActive(item: T) {
      setActiveKey(keyOf(item));
    },
    /** Back to the first option (a new search). */
    reset() {
      setActiveKey(null);
    },
  };
}
