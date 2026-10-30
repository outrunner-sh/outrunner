"use client";

import { keptPage } from "@/lib/client/kept-page";
import { parseRecentSelection, type RecentSelection } from "@/lib/session/recent-selection";

/** Scoped to the signed-in user and org, and kept across navigation/reloads. */
export const RECENT_SELECTION = keptPage<RecentSelection>("session-selection", 1,
  (value): value is RecentSelection => parseRecentSelection(value) !== null);
