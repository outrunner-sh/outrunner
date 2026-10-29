"use client";

import { createContext, useContext } from "react";

import type { AppData } from "@/lib/session/session-view";

const AppDataContext = createContext<AppData | null>(null);
const ViewerScopeContext = createContext<string | null>(null);

/** The layout's sidebar data, for the pages under it to render from at once. */
export function AppDataProvider({ value, children }: { value: AppData | null; children: React.ReactNode }) {
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** Whose view the frame shows (viewerScope, lib/orgs/active.ts), for the pages
 *  that keep what they showed for their next visit. */
export function ViewerScopeProvider({ value, children }: { value: string | null; children: React.ReactNode }) {
  return <ViewerScopeContext.Provider value={value}>{children}</ViewerScopeContext.Provider>;
}

/** The signed-in user in the org the app shows; null until the layout says
 *  (a cold start), when nothing kept is shown. */
export function useViewerScope(): string | null {
  return useContext(ViewerScopeContext);
}

/** The layout's data; null until it streams in (a cold start), or outside the
 *  layout, when a page has to ask the server instead. */
export function useAppData(): AppData | null {
  return useContext(AppDataContext);
}
