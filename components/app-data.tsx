"use client";

import { createContext, useContext } from "react";

import type { AppData } from "@/lib/session/session-view";

const AppDataContext = createContext<AppData | null>(null);

/** The layout's sidebar data, for the pages under it to render from at once. */
export function AppDataProvider({ value, children }: { value: AppData; children: React.ReactNode }) {
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** The layout's data; null outside it (signed out, the layout renders the page
 *  alone), when a page has to ask the server instead. */
export function useAppData(): AppData | null {
  return useContext(AppDataContext);
}
