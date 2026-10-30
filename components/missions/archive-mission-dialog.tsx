"use client";

import { ConfirmSessionDialog } from "@/components/confirm-session-dialog";
import { refreshMissions } from "@/hooks/use-missions";
import { missionArchiveConsequence, requestMissionArchive } from "@/lib/missions/archive";

/**
 * Confirm archiving a Mission with its Ships (lib/missions/archive.ts): how
 * many go with it and how they come back, then a click (it's undone by
 * opening it, so no hold). The Missions are read again either way: a refusal
 * may have archived some of its Ships. `onArchived` runs once it is, to leave
 * it if it's on screen: left open, its page would restore it at once.
 */
export function ArchiveMissionDialog({
  mission,
  onOpenChange,
  onArchived,
}: {
  /** The Mission to archive, and its Ships that aren't archived; null keeps
   *  the dialog closed. */
  mission: { id: string; title: string; ships: number } | null;
  onOpenChange: (open: boolean) => void;
  onArchived: (id: string) => void;
}) {
  return (
    <ConfirmSessionDialog
      open={mission !== null}
      title={mission?.ships ? `Archive “${mission.title}” and its Ships?` : `Archive “${mission?.title ?? ""}”?`}
      description={missionArchiveConsequence(mission?.ships ?? 0)}
      // Each Ship's work is saved as it's archived, a few at a time.
      busyLabel={mission?.ships ? "Archiving it and its Ships" : "Archiving"}
      failure="Could not archive this Mission."
      confirm={(go) => (
        <button type="button" onClick={go} className="route-state-button is-primary">
          Archive Mission
        </button>
      )}
      run={async () => {
        if (!mission) return null;
        try {
          // Ships archived without their files are said, with Done.
          return await requestMissionArchive(mission.id);
        } finally {
          void refreshMissions();
        }
      }}
      onOpenChange={onOpenChange}
      onDone={() => {
        if (mission) onArchived(mission.id);
      }}
    />
  );
}
