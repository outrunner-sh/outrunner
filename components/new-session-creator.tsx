import { BackButton } from "@/components/back-button";
import { NewSessionForm } from "@/components/new-session-form";
import type { Project } from "@/lib/runtime/types";

/**
 * The full-page new-session screen: a faded wordmark over the shared
 * new-session form. Used by the /new route (deep links + the no-workspaces
 * empty state); the home page opens the same form in a modal instead.
 */
export function NewSessionCreator({
  projects,
  initialProjectId,
  showBack = false,
}: {
  projects: Project[];
  initialProjectId?: string;
  /** /new is reached from somewhere and needs a way back; the home page's
   *  no-workspaces state is home already. */
  showBack?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-6">
      {showBack && (
        <div className="absolute left-4 top-4">
          <BackButton />
        </div>
      )}
      <div className="w-full max-w-2xl">
        <p
          aria-hidden
          className="pointer-events-none mb-6 select-none text-center text-[13vw] font-bold leading-none tracking-tight text-neutral-800 sm:text-[96px]"
        >
          outrunner
        </p>
        <NewSessionForm projects={projects} initialProjectId={initialProjectId} />
      </div>
    </div>
  );
}
