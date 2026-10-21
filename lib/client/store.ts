"use client";

import { useSyncExternalStore } from "react";

/** A value the whole page shares, for components to re-render on as it changes. */
export type Store<T> = {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
};

export function store<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A {@link Store}'s value now. A server render (and hydration) sees `initial`. */
export function useStore<T>(of: Store<T>, initial: T): T {
  return useSyncExternalStore(of.subscribe, of.get, () => initial);
}
