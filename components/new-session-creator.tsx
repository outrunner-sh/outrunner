import { BackButton } from "@/components/back-button";
import { NewSessionForm } from "@/components/new-session-form";
import type { ListedEnvironment } from "@/lib/environments/listed";
import type { StartingPick } from "@/lib/onboarding/rules";
import type { Project } from "@/lib/runtime/types";

/**
 * The full-page new-session screen. It is home (/), so starting a session is
 * always one prompt away, and /new (the sidebar's "+" links, which name the
 * repository or folder to start on).
 */
export function NewSessionCreator({
  projects,
  environments,
  projectsKnown = true,
  initialProjectId,
  initialEnvironmentId,
  openPicker = false,
  focusComposer = false,
  initialPick,
  showBack = false,
  workItemId,
  children,
}: {
  projects: Project[];
  environments?: ListedEnvironment[];
  /** False until the list arrives (a cold start). */
  projectsKnown?: boolean;
  initialProjectId?: string;
  initialEnvironmentId?: string;
  /** Opens the repository (or folder) picker as the form mounts. */
  openPicker?: boolean;
  /** Focuses the composer as the form mounts. */
  focusComposer?: boolean;
  /** What the session starts on until another is picked. */
  initialPick?: StartingPick;
  /** /new is reached from somewhere and needs a way back where the sidebar is
   *  hidden (narrow windows); home is home already. */
  showBack?: boolean;
  /** The triage item to start from (`?triage=`). */
  workItemId?: string;
  /** Home's recent sessions, below the shared creation form. */
  children?: React.ReactNode;
}) {
  return (
    <div className="relative h-full">
      {showBack && (
        <div className="absolute left-4 top-4 z-10 sm:hidden">
          <BackButton />
        </div>
      )}
      <NewSessionForm
        projects={projects}
        environments={environments}
        projectsKnown={projectsKnown}
        initialProjectId={initialProjectId}
        initialEnvironmentId={initialEnvironmentId}
        openPicker={openPicker}
        focusComposer={focusComposer}
        initialPick={initialPick}
        workItemId={workItemId}
      >
        {children}
      </NewSessionForm>
    </div>
  );
}
