"use client";

import Link from "next/link";
import { useState } from "react";

import { NewSessionDialog } from "@/components/new-session-dialog";
import type { Project } from "@/lib/runtime/types";

export type SessionItem = { id: string; title: string; project: string };

/**
 * The home page's center (the app sidebar is the layout's): just text, with a
 * greeting, a Start action and the last session to Continue. New sessions open
 * in a modal, defaulting to the last session's repository.
 */
export function HomeView({
  ownerLogin,
  projects,
  lastSession,
  lastProjectId,
}: {
  ownerLogin: string;
  /** Every repository: feeds the new-session modal's picker. */
  projects: Project[];
  /** Most-recent session, surfaced as the single "Continue" link. */
  lastSession: SessionItem | null;
  /** Repo of the most-recent session: the modal's default project. */
  lastProjectId?: string;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const name = ownerLogin
    ? ownerLogin.charAt(0).toUpperCase() + ownerLogin.slice(1)
    : "there";

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 sm:px-8">
      <div className="w-full max-w-sm space-y-8 py-16">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            Taking a breather, {name}?
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            @{ownerLogin || "outrunner"} · outrunner
          </p>
        </div>

        <section>
          <h2 className="mb-2 text-sm text-muted-foreground">Start</h2>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="block py-1 text-[15px] text-foreground transition-colors hover:text-muted-foreground"
          >
            New session
          </button>
        </section>

        {lastSession && (
          <section>
            <h2 className="mb-2 text-sm text-muted-foreground">Continue</h2>
            <Link
              href={`/workspaces/${lastSession.id}`}
              className="group flex items-baseline gap-2 py-1"
            >
              <span className="min-w-0 truncate font-semibold text-foreground transition-colors group-hover:text-muted-foreground">
                {lastSession.title}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {lastSession.project}
              </span>
            </Link>
          </section>
        )}
      </div>

      <NewSessionDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        projects={projects}
        initialProjectId={lastProjectId}
      />
    </div>
  );
}
