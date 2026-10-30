"use client";

import type { AgentId } from "@/lib/agents/registry";
import { selectionMenu } from "./selection-fixtures";
import { useState } from "react";
import { SessionInfo } from "@/components/session-info";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { SessionDidntStart } from "@/components/session-didnt-start";
import { frame } from "./fixtures";
import { WorkspaceSession } from "@/components/workspace-session";

/** Test-only host: readiness changes without remounting the real composer. */
export function StartupFixture({ agent = "claude", shared = false, mission = false, legacy = false }: { agent?: AgentId; shared?: boolean; mission?: boolean; legacy?: boolean }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState(false);
  const selection = agent === "codex" && !shared ? { model: selectionMenu.codexModels![0], effort: "high" as const } : { model: { id: "moonshotai/kimi-k3", label: "Kimi K3", provider: "outrunner" as const, supportsImages: true }, effort: null };
  const startedAt = "2026-10-29T21:00:00Z";
  return (
    <div className="studio-shell no-inspector">
      <header className="studio-header">
        <button onClick={() => setReady(true)}>Finish fixture startup</button>
        <button onClick={() => setFailed(true)}>Fail startup</button>
        <SessionInfo workspaceId="startup-fixture" open={info} onOpenChange={setInfo} details={!ready && <WorkspaceCreating projectName="outrunner" branch="runtime/startup" startedAt={startedAt} phase="allocate" hasExistingComputer={false} />} />
      </header>
      <section className="studio-chat">{failed ? <SessionDidntStart workspace={{ ...frame.appData.workspaces[0], id: "startup-fixture", status: "failed", agent, model: selection, ...(mission && { kind: "mission", title: "Security audit", environmentId: legacy ? null : "mission-environment" }) }} detail="Controlled startup failure" /> : <WorkspaceSession
        workspaceId="startup-fixture"
        agent={agent}
        initialPrompt="hi"
        initialPromptKey="startup-first"
        startup={ready ? undefined : { startedAt, stalled: false, onDetails: () => setInfo(true) }}
        recorded={selection}
      />}</section>
    </div>
  );
}
