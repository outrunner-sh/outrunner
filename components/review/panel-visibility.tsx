"use client";

import { createContext, useContext } from "react";

/** Retained panels pause effects while their UI is hidden. */
export const ReviewPanelVisibility = createContext(true);
export const useReviewPanelVisible = () => useContext(ReviewPanelVisibility);
