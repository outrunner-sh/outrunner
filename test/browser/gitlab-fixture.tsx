"use client";

import { useState, useSyncExternalStore } from "react";
import { GitLabConnectionCard } from "@/components/gitlab-connection-card";
import { RepositorySelect } from "@/components/repository-select";
import type { Project } from "@/lib/runtime/types";
import { project } from "./fixtures";

const subscribe = () => () => {};

/** Production components, with network requests supplied by the browser test. */
export function GitLabFixture({ connected }: { connected: boolean }) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const projects = [project];
  const [selected, setSelected] = useState<Project | null>(null);
  return <main data-testid="gitlab-fixture" data-ready={ready} className="mx-auto max-w-2xl space-y-8 p-6">
    <div className="space-y-1"><h1 className="text-xl font-semibold">Code providers</h1><p className="text-sm text-muted-foreground">GitHub and GitLab repositories for your sessions.</p></div>
    <GitLabConnectionCard initial={connected ? { login: "ada", updatedAt: "2026-11-13T00:00:00Z" } : null} />
    <section className="space-y-3"><h2 className="text-sm font-medium">Start a session</h2>
      <RepositorySelect projects={selected ? [...projects, selected] : projects} selectedProjectId={selected?.id} onSelect={setSelected} />
      {selected && <p role="status" className="text-sm">Selected {selected.fullName}</p>}
    </section>
  </main>;
}
