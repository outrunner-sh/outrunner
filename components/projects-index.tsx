import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { GitHubIcon } from "@/components/brand-icons";
import { ProjectsSyncButton } from "@/components/projects-sync-button";
import type { Project } from "@/lib/runtime/types";

export function ProjectsIndex({ projects, canSync }: { projects: Project[]; canSync: boolean }) {
  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-lg font-semibold text-foreground">Projects</h1>
            <p className="text-[13px] text-muted-foreground">
              Connected repositories and their project environments, setup, variables and files.
            </p>
          </div>
          {canSync && <ProjectsSyncButton />}
        </header>

        {projects.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {canSync ? "No repositories connected yet. Sync repositories to add them here." : "No projects are available in this org yet."}
          </p>
        ) : (
          <section className="space-y-2" aria-labelledby="connected-repositories">
            <h2 id="connected-repositories" className="px-1 text-[12px] text-muted-foreground">
              Connected repositories
            </h2>
            <ul className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                  >
                    <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{project.fullName}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {project.defaultBranch} · Project and environment settings
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
