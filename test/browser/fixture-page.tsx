"use client";

import { SandboxSettingsForm } from "@/components/sandbox-settings";
import { PLANS } from "@/lib/billing/plans";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { WorkspaceStudio } from "@/components/workspace-studio";
import { usePendingSession } from "@/lib/session/pending-sessions";
import { selectionMenu } from "./selection-fixtures";
import { CLAUDE_DEFAULT_MODEL } from "@/lib/runtime/session-models";
import type { Workspace } from "@/lib/runtime/types";
import { StartupFixture } from "./startup-fixture";
import { Automations } from "@/components/automations";
import { AutomationsLoading } from "@/components/automations-loading";
import { Markdown } from "@/components/markdown";
import { PullRequestChip } from "@/components/missions/mission-parts";
import { HomeSessionRoute, NewSessionRoute } from "@/components/new-session-route";
import { OrgGitHubSettings } from "@/components/org-github";
import { OrgGeneralSettings } from "@/components/org-settings";
import { PageLayout } from "@/components/page-layout";
import { ProjectSettings } from "@/components/project-settings";
import { PullHeading, PullInfo } from "@/components/review/pull-detail";
import { PullFiles } from "@/components/review/pull-files";
import { ReviewChat } from "@/components/review/review-chat";
import { ReviewLayout } from "@/components/review/review-layout";
import { ReviewList } from "@/components/review/review-list";
import { ServerAnswer } from "@/components/server-answer";
import { SettingsFrame } from "@/components/settings-frame";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  automations,
  environment,
  frame,
  pull,
  pulls,
  runnerPull,
  templates,
} from "./fixtures";

const subscribe = () => () => {};

/** A standalone test app: fixture navigation and APIs can never reach real resources. */
export function FixturePage() {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const params = useSearchParams();
  const pathname = usePathname();
  const view =
    params.get("view") ??
    (pathname.startsWith("/projects/") ? "project" : pathname.startsWith("/workspaces/") ? "session" : "home");
  const state =
    params.get("state") ??
    (pathname.includes("readonly") ? "readonly" : "normal");
  const org = {
    id: "org-1",
    name: "neev ai",
    personal: false,
    role: state === "member" ? ("member" as const) : ("admin" as const),
  };
  const detail = useMemo(
    () => ({
      ...pull,
      ...(state === "long"
        ? { title: "W".repeat(180), headRef: `feature/${"branch".repeat(35)}` }
        : {}),
      ...(state === "merged" ? { state: "merged" as const } : {}),
      ...(state === "large"
        ? {
            changedFiles: 500,
            files: Array.from({ length: 500 }, (_, i) => ({
              ...pull.files![0],
              path: `lib/file-${i}.ts`,
              additions: 1000,
            })),
          }
        : {}),
    }),
    [state],
  );
  let content: React.ReactNode;
  if (view === "sandbox") content = <PageLayout><SandboxSettingsForm initial={{ sandbox: state === "connected" ? "gcp" : "outrunner", daytona: { connected: false, hint: null, updatedAt: null }, modal: { connected: false, hint: null, updatedAt: null }, gcp: { connected: state === "connected", hint: state === "connected" ? "sandbox-project" : null, updatedAt: null }, boxSize: "small", boxSizeChosen: true }} sizes plan={PLANS.free} /></PageLayout>;
  else if (view === "session") content = <FixtureSession id={pathname.split("/")[2] ?? "preview-0"} agent={params.get("harness") === "claude" ? "claude" : "codex"} />;
  else if (view === "project")
    content = (
      <ProjectSettings
        initial={{
          ...environment,
          ...(state === "long" ? { name: "W".repeat(80) } : {}),
          access: state === "readonly" ? "read" : "write",
        }}
      />
    );
  else if (view === "review")
    content = (
      <ReviewList
        scope="browser-fixture"
        data={{
          orgName: "neev ai",
          pulls:
            state === "empty" || state === "error"
              ? []
              : state === "long"
                ? [
                    {
                      ...pulls[0],
                      title: "W".repeat(180),
                      author: "owner".repeat(25),
                    },
                  ]
                : pulls,
          unreachable: state === "unreachable" ? ["neevai-labs/private"] : [],
          error:
            state === "error"
              ? "Couldn't load pull requests. Please try again."
              : undefined,
        }}
      />
    );
  else if (view === "detail")
    content = (
      <ReviewLayout
        key={state}
        prKey={`${detail.repo}#${detail.number}`}
        toolbar={
          <>
            <span className="text-xs text-muted-foreground">
              Review <span className="px-2">/</span> {detail.repo} #
              {detail.number}
            </span>
            <Button size="sm" disabled={state === "merged"}>
              Merge
            </Button>
          </>
        }
        heading={<PullHeading pr={detail} />}
        info={<PullInfo pr={detail} />}
        description={<Markdown>{detail.body}</Markdown>}
        files={
          <PullFiles
            repo={detail.repo}
            number={detail.number}
            headSha={detail.headSha}
            files={detail.files}
            complete={detail.filesComplete}
            lines={detail.lines}
            changedFiles={detail.changedFiles}
          />
        }
        chat={
          <ReviewChat
            repo={detail.repo}
            number={detail.number}
            canChange={state !== "merged"}
          />
        }
      />
    );
  else if (view === "automations")
    content =
      state === "loading" ? (
        <AutomationsLoading />
      ) : (
        <Automations
          org={org}
          appSlug="outrunner-connector"
          installations={[{ login: "neevai-labs", suspended: false }]}
          automations={
            state === "error" ? null : state === "empty" ? [] : automations
          }
          runs={[]}
          runsLimit={50}
          runKind={null}
          templates={templates}
        />
      );
  else if (view === "chips")
    content = (
      <PageLayout>
        <div className="space-y-6">
          <div>
            <p className="mb-2 text-sm">Merged sidebar status</p>
            <a href="#merged" aria-label="Secondary panes">
              <PullRequestChip pr={runnerPull} compact link={false} />
            </a>
          </div>
          <div>
            <p className="mb-2 text-sm">Runner details</p>
            <PullRequestChip pr={runnerPull} />
          </div>
          <div>
            <p className="mb-2 text-sm">Open sidebar status</p>
            <PullRequestChip
              pr={{ ...runnerPull, state: "open" }}
              compact
              link={false}
            />
          </div>
        </div>
      </PageLayout>
    );
  else if (view === "surfaces")
    content = (
      <PageLayout className="space-y-8">
        <h1 className="text-xl">Shared controls</h1>
        <Button>Primary action</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Open dropdown</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Menu action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open modal</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Project details</DialogTitle>
            <DialogDescription>A shared modal surface.</DialogDescription>
            <Button>Save changes</Button>
          </DialogContent>
        </Dialog>
      </PageLayout>
    );
  else if (view === "startup") content = <StartupFixture agent={params.get("harness") === "codex" ? "codex" : "claude"} shared={params.get("shared") === "1"} mission={params.get("kind") === "mission"} legacy={params.get("legacy") === "1"} />;
  else content = pathname === "/new" ? <NewSessionRoute server={<ServerAnswer value={null} />} /> : <HomeSessionRoute />;
  return (
    <>
      <span hidden data-testid="fixture-ready" data-ready={ready} />
      {view === "github" ? (
        <SettingsFrame>
          <OrgGitHubSettings
            org={{ ...org, name: "neevcloud" }} configured
            installations={state === "connected" ? [{
              id: 42, accountLogin: "neevai-labs", accountType: "Organization", repositorySelection: "all",
              suspendedAt: null, suspended: false, installedBy: "preview-owner", createdAt: "2026-10-30T00:00:00Z",
              repositories: ["neevai-labs/outrunner"], total: 1, reachable: true,
            }] : []}
            available={state !== "connected" ? [{
              id: 42, accountLogin: "neevai-labs", accountType: "Organization", repositorySelection: "all",
              suspendedAt: null, suspended: false, installedBy: null, createdAt: "2026-10-30T00:00:00Z",
            }] : []}
            pending={false} installed={null} error={null}
          />
        </SettingsFrame>
      ) : view === "settings" ? (
        <SettingsFrame>
          <OrgGeneralSettings org={org} domain="neev.ai" />
        </SettingsFrame>
      ) : (
        content
      )}
    </>
  );
}

function FixtureSession({ id, agent }: { id: string; agent: "claude" | "codex" }) {
  const params = useSearchParams();
  const pending = usePendingSession(id);
  // The mission endpoint in runner-retry.spec.ts returns this Runner.
  if (id === "runner-replacement") return <WorkspaceStudio workspace={{ ...frame.appData.workspaces[0], id, kind: "mission", title: "Security audit", agent: "claude", status: "ready" }} projectName="fixture/composer" pullRequest={null} />;
  const sourceClaude = params.get("agent") === "claude" || agent === "claude";
  const workspace = pending?.workspace ?? { ...frame.appData.workspaces[0], id, agent: sourceClaude ? "claude" as const : "codex" as const,
    model: { model: sourceClaude ? CLAUDE_DEFAULT_MODEL : selectionMenu.codexModels![0], effort: "high" as const } };
  if (params.get("selection") === "saved") return <SavedFixtureSession workspace={workspace} mission={params.get("kind") === "mission"} />;
  return <WorkspaceStudio workspace={{ ...workspace, status: "ready", ...(params.get("kind") === "mission" && { kind: "mission" as const }) }} projectName="fixture/composer" pullRequest={null} />;
}

/** Reload with the selection the API last persisted, as the real page does. */
function SavedFixtureSession({ workspace, mission }: { workspace: Workspace; mission: boolean }) {
  const [saved, setSaved] = useState<Pick<Workspace, "agent" | "model"> | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/fixture-selection").then((response) => response.json()).then((selection) => {
      if (live) setSaved(selection);
    });
    return () => { live = false; };
  }, []);
  if (!saved) return null;
  return <WorkspaceStudio workspace={{ ...workspace, ...saved, status: "ready", ...(mission && { kind: "mission" as const }) }} projectName="fixture/composer" pullRequest={null} />;
}
