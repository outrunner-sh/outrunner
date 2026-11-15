"use client";

import { useState } from "react";

import { WorkspaceEnvironment } from "@/components/workspace-environment";
import type { SessionSender } from "@/components/workspace-session";
import { frame } from "./fixtures";

const sender: SessionSender = {
  send: async (content, attachmentIds) => (await fetch("/api/fixture-pr-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, attachmentIds }),
  })).ok,
};

/** The real Environment panel, with no live agent or code-provider writes. */
export function PullRequestFixture() {
  const [branch, setBranch] = useState("runtime/fixture");
  const [view, setView] = useState<"overview" | "changes" | "canvas">("overview");
  return (
    <div className="mx-auto w-full max-w-md">
      <button type="button" onClick={() => setBranch("fix/existing-pr")}>Rename fixture branch</button>
      <WorkspaceEnvironment
        workspace={{ ...frame.appData.workspaces[0], id: "pr-fixture", branch, status: "ready" }}
        pullRequest={null}
        isReady
        sender={sender}
        onClose={() => {}}
        view={view}
        onViewChange={setView}
      />
    </div>
  );
}
