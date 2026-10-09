import { BackButton } from "@/components/back-button";
import { NewSessionForm } from "@/components/new-session-form";
import type { Project } from "@/lib/runtime/types";

/**
 * The full-page new-session screen. It is home (/), so starting a session is
 * always one prompt away, and /new (the sidebar's "+" links, which name the
 * repository or folder to start on).
 */
export function NewSessionCreator({
  projects,
  initialProjectId,
  showBack = false,
}: {
  projects: Project[];
  initialProjectId?: string;
  /** /new is reached from somewhere and needs a way back where the sidebar is
   *  hidden (narrow windows); home is home already. */
  showBack?: boolean;
}) {
  return (
    <div className="relative h-full">
      {showBack && (
        <div className="absolute left-4 top-4 z-10 sm:hidden">
          <BackButton />
        </div>
      )}
      <NewSessionForm projects={projects} initialProjectId={initialProjectId} />
    </div>
  );
}
