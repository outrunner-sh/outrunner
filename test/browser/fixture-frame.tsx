"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AppFrame } from "@/components/app-frame";
import { ServerAnswer } from "@/components/server-answer";
import { frame, manyProjects } from "./fixtures";

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
  const pathname = usePathname();
  const state = params.get("state");
  const shownFrame = useMemo(() => {
    if (state === "archived") {
      return {
        ...frame,
        appData: {
          ...frame.appData,
          workspaces: frame.appData.workspaces.map((workspace, i) =>
            i === 0 ? { ...workspace, status: "archived" as const } : workspace,
          ),
        },
      };
    }
    if (state === "merged-sidebar") {
      return {
        ...frame,
        appData: {
          ...frame.appData,
          pullRequests: {
            "preview-0": {
              id: "pull-request-1",
              workspaceId: "preview-0",
              projectId: "project-1",
              number: 343,
              url: "https://github.com/neevai-labs/outrunner/pull/343",
              title: "Improve workspace navigation",
              baseBranch: "main",
              headBranch: "runtime/preview-0",
              createdAt: "2026-10-30T07:00:00Z",
              state: "merged" as const,
              stateAt: "2026-10-30T10:00:00Z",
            },
          },
          standings: {
            "preview-0": sidebarDone("2026-10-30T10:00:00Z"),
            "preview-1": sidebarDone("2026-10-30T09:00:00Z"),
          },
        },
      };
    }
    if (state === "many-projects") {
      return { ...frame, activeOrgId: "org-1", appData: { ...frame.appData, projects: manyProjects } };
    }
    if (state === "recent-selection") {
      return { ...frame, activeOrgId: "org-1", appData: { ...frame.appData, workspaces: frame.appData.workspaces.map((workspace, i) =>
        i === 0 ? { ...workspace, agent: "codex" as const, model: { model: { id: "account-code", provider: "codex" as const, label: "Account coding model" }, effort: "low" as const } } : workspace) } };
    }
    return { ...frame, activeOrgId: "org-1" };
  }, [state]);
  if (["agent-keys", "settings", "sandbox", "desktop-signin", "web-onboarding", "desktop-ready"].includes(params.get("view") ?? "") || pathname.startsWith("/auth/desktop/")) return children;
  return (
    <AppFrame chrome={<ServerAnswer value={chrome} />} server={<ServerAnswer value={shownFrame} />}>
      {children}
    </AppFrame>
  );
}

function sidebarDone(at: string) {
  return {
    standing: "done" as const,
    reason: null,
    moved: false,
    pinned: false,
    unread: false,
    replyPreview: null,
    at,
  };
}
