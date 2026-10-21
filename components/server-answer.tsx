"use client";

import { createContext, useContext, useLayoutEffect, useState } from "react";

const ServerAnswerContext = createContext<(answer: unknown) => void>(() => {});

/**
 * A page that renders at once from what the browser holds, and takes what only
 * the server knows as it streams in: `server` is a server part under Suspense
 * that renders a {@link ServerAnswer}. Returns the answer (null until it
 * arrives) and the element to render `server` in. The page's own content keeps
 * its place in the tree either way, so an answer arriving never remounts it.
 */
export function useServerAnswer<T>(server: React.ReactNode): [T | null, React.ReactNode] {
  const [answer, setAnswer] = useState<T | null>(null);
  const slot = (
    <ServerAnswerContext.Provider value={setAnswer as (answer: unknown) => void}>{server}</ServerAnswerContext.Provider>
  );
  return [answer, slot];
}

/** Hands `value` to the page rendering it (useServerAnswer). Shows nothing. */
export function ServerAnswer<T>({ value }: { value: T }) {
  const set = useContext(ServerAnswerContext);
  useLayoutEffect(() => set(value), [set, value]);
  return null;
}
