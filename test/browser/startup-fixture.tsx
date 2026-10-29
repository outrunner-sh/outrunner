"use client";

import { useState } from "react";
import { SessionInfo } from "@/components/session-info";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { WorkspaceSession } from "@/components/workspace-session";

/** Test-only host: readiness changes without remounting the real composer. */
export function StartupFixture() {
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState(false);
  const startedAt = "2026-10-29T21:00:00Z";
  return (
    <div className="studio-shell no-inspector">
      <header className="studio-header">
        <button onClick={() => setReady(true)}>Finish fixture startup</button>
        <SessionInfo workspaceId="startup-fixture" open={info} onOpenChange={setInfo} details={!ready && <WorkspaceCreating projectName="outrunner" branch="runtime/startup" startedAt={startedAt} phase="allocate" hasExistingComputer={false} />} />
      </header>
      <section className="studio-chat"><WorkspaceSession
        workspaceId="startup-fixture"
        initialPrompt="hi"
        initialPromptKey="startup-first"
        startup={ready ? undefined : { startedAt, stalled: false, onDetails: () => setInfo(true) }}
        recorded={{ model: { id: "moonshotai/kimi-k3", label: "Kimi K3", provider: "outrunner", supportsImages: true }, effort: null }}
      /></section>
    </div>
  );
}
