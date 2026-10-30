"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AppFrame } from "@/components/app-frame";
import { ServerAnswer } from "@/components/server-answer";
import { frame } from "./fixtures";

const chrome = {
  collapsed: false,
  folded: [],
  getStartedSkipped: true,
  grouping: "status",
  pickedOrgId: null,
};
/** Match the real app: the frame persists across page navigation. */
export function FixtureFrame({ children }: { children: React.ReactNode }) {
  const params = useSearchParams();
  const state = params.get("state");
  const shownFrame = useMemo(() => state === "archived" ? {
    ...frame,
    appData: {
      ...frame.appData,
      workspaces: frame.appData.workspaces.map((workspace, i) => i === 0 ? { ...workspace, status: "archived" as const } : workspace),
    },
  } : frame, [state]);
  if (params.get("view") === "settings") return children;
  return (
    <AppFrame chrome={<ServerAnswer value={chrome} />} server={<ServerAnswer value={shownFrame} />}>
      {children}
    </AppFrame>
  );
}
