"use client";

import { ChevronRight, Layers, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { PageHeader, PageLayout } from "@/components/page-layout";
import { RepositoryPicker } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Environment } from "@/lib/db/environments";
import type { ListedEnvironment } from "@/lib/environments/listed";
import { MAX_REPOS } from "@/lib/environments/rules";
import { requestJson } from "@/lib/http/request-json";
import type { Project } from "@/lib/runtime/types";

/** What the page knows of the user in the org, beside its lists: whether
 *  they may connect repositories (write on all of them), and whether they
 *  administer it (its default environment is theirs to set). */
export type EnvironmentsAccess = { canConnect: boolean; admin: boolean; orgName: string };

/** Which panel is open: picking repositories into an environment, or
 *  making a new one. */
type Panel = { kind: "add"; environment: ListedEnvironment } | { kind: "new" } | null;

/**
 * Environments: what sessions start from, each a set of the org's
 * repositories with its setup (lib/environments/listed.ts says which are
 * listed). Picking repositories (the one RepositoryPicker) connects them and
 * puts them in an environment: the org's default when it has one, else a new
 * one, named after the org and made its default when an admin makes it.
 * `pick` (Settings → Org → GitHub's "Pick repositories", `?pick=1`) opens that
 * at once.
 *
 * Below, the connected repositories: each has its own environment too, which
 * a session started from the repository alone, the API and automations start
 * from; its settings open from here.
 */
export function ProjectsIndex({
  environments,
  projects,
  access,
  pick = false,
  onPicked,
}: {
  environments: ListedEnvironment[];
  projects: Project[];
  access: EnvironmentsAccess;
  /** Open the repository picker as the page opens. */
  pick?: boolean;
  /** The picker was opened from the URL: it can forget it now. */
  onPicked?: () => void;
}) {
  const router = useRouter();
  const orgDefault = environments.find((e) => e.orgDefault) ?? null;
  const pickPanel = (): Panel =>
    orgDefault && orgDefault.repos.length < MAX_REPOS ? { kind: "add", environment: orgDefault } : { kind: "new" };
  const [panel, setPanel] = useState<Panel>(() => (pick && access.canConnect ? pickPanel() : null));
  // Asked again while open (Settings → Org → GitHub, back and forth).
  const [pickSeen, setPickSeen] = useState(pick);
  if (pick !== pickSeen) {
    setPickSeen(pick);
    if (pick && access.canConnect) setPanel(pickPanel());
  }

  const close = () => {
    setPanel(null);
    onPicked?.();
  };
  const done = (href?: string) => {
    close();
    // The sidebar's lists (and this page's) have the new repositories and
    // environment once the layout reads them again.
    if (href) router.push(href);
    router.refresh();
  };

  return (
    <PageLayout className="space-y-8">
      <PageHeader
        title="Environments"
        description="What sessions start with: repositories, setup, variables, files, skills and MCP servers."
        actions={
          access.canConnect &&
          !panel && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setPanel(pickPanel())}>
                <GitHubIcon /> Pick repositories
              </Button>
              <Button size="sm" onClick={() => setPanel({ kind: "new" })}>
                <Plus /> New environment
              </Button>
            </div>
          )
        }
      />

      {panel?.kind === "add" && (
        <section className="space-y-3" aria-labelledby="add-repositories">
          <h2 id="add-repositories" className="text-sm font-medium">
            Add repositories to {panel.environment.name}
          </h2>
          <RepositoryPicker
            inEnvironment={panel.environment.repos.map((r) => r.fullName)}
            max={MAX_REPOS - panel.environment.repos.length}
            submitLabel={`Add to ${panel.environment.name}`}
            onCancel={close}
            onPicked={async (picked) => {
              await requestJson<Environment>(`/api/environments/${panel.environment.id}/repos`, {
                method: "POST",
                body: { projectIds: picked.map((p) => p.id) },
                has: (d) => d.id !== undefined,
              });
              done();
            }}
          />
        </section>
      )}
      {panel?.kind === "new" && (
        <NewEnvironment
          // The org's first, made by an admin, is its default, named after it.
          makeDefault={!orgDefault && access.admin}
          defaultName={orgDefault ? "" : access.orgName}
          onCancel={close}
          onMade={(id) => done(`/environments/${id}`)}
        />
      )}

      <section className="space-y-2" aria-labelledby="environments">
        <h2 id="environments" className="px-1 text-[12px] text-muted-foreground">
          Environments
        </h2>
        {environments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-[13px] text-muted-foreground">
            {access.canConnect
              ? "No environments yet. Pick the repositories this org works on to make its first."
              : "No environments yet. An admin of this org picks its repositories."}
          </p>
        ) : (
          <ul className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60">
            {environments.map((environment) => (
              <li key={environment.id}>
                <Link
                  href={`/environments/${environment.id}`}
                  className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                >
                  <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px] text-foreground">
                      <span className="truncate">{environment.name}</span>
                      {environment.orgDefault && (
                        <span className="shrink-0 rounded border border-border/60 px-1.5 text-[11px] text-muted-foreground">Default</span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {environment.repos.map((r) => r.fullName).join(", ") || "No repositories"}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {projects.length > 0 && (
        <section className="space-y-2" aria-labelledby="connected-repositories">
          <div className="px-1">
            <h2 id="connected-repositories" className="text-[12px] text-muted-foreground">
              Connected repositories
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Each has its own settings too, used when a session, the API or an automation starts from the repository alone.
            </p>
          </div>
          <ul className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/environments/${project.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                >
                  <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{project.fullName}</span>
                    <span className="block text-[11px] text-muted-foreground">{project.defaultBranch} · Repository settings</span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageLayout>
  );
}

/** A new environment: its name, then its repositories, picked (and
 *  connected) with the repository picker, which makes it. */
function NewEnvironment({
  makeDefault,
  defaultName,
  onCancel,
  onMade,
}: {
  /** Made the org's default as it's made. */
  makeDefault: boolean;
  defaultName: string;
  onCancel: () => void;
  onMade: (id: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  return (
    <section className="space-y-3" aria-labelledby="new-environment">
      <div className="space-y-1">
        <h2 id="new-environment" className="text-sm font-medium">
          New environment
        </h2>
        {makeDefault && <p className="text-xs text-muted-foreground">The org&apos;s first: new sessions start from it unless another is picked.</p>}
      </div>
      <label className="block max-w-sm space-y-1">
        <span className="text-xs text-muted-foreground">Name</span>
        <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Environment name" />
      </label>
      <RepositoryPicker
        max={MAX_REPOS}
        submitLabel="Create environment"
        submitBlocked={!name.trim()}
        onCancel={onCancel}
        onPicked={async (picked) => {
          const made = await requestJson<Environment>("/api/environments", {
            method: "POST",
            body: { name: name.trim(), projectIds: picked.map((p) => p.id), ...(makeDefault && { orgDefault: true }) },
            has: (d) => d.id !== undefined,
          });
          onMade(made.id);
        }}
      />
    </section>
  );
}
