"use client";

import { usePathname, useRouter } from "next/navigation";

import { useLocalSessions } from "@/hooks/use-local-sessions";
import { store, useStore } from "@/lib/client/store";
import { ConfirmSessionDialog } from "@/components/confirm-session-dialog";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { activeSessionId, deletionConsequence, type SessionDeletion } from "@/lib/nav/sidebar";
import { deleteSession } from "@/lib/session/delete-session";

type DeletionTarget = { id: string; title: string; deletion: SessionDeletion };
const TARGET = store<DeletionTarget | null>(null);

/** Open the app's persistent confirmation, including from a session header. */
export function requestSessionDeletion(session: DeletionTarget): void {
  TARGET.set(session);
}

/** Kept in AppFrame so navigation and a collapsed sidebar cannot hide errors. */
export function SessionDeletionDialog() {
  const session = useStore(TARGET, null);
  const router = useRouter();
  const pathname = usePathname();
  const { refresh } = useLocalSessions();
  return (
    <DeleteSessionDialog
      session={session}
      onOpenChange={(open) => { if (!open) TARGET.set(null); }}
      onDeleting={(id) => {
        if (id === activeSessionId(pathname)) router.push("/");
      }}
      onDeleted={() => {
        router.refresh();
        refresh();
      }}
    />
  );
}

/**
 * Confirm deleting a session: what goes and what stays, then a hold (not a
 * click) to do it. `onDeleting` runs just before, so the caller can leave the
 * session if it is open (its page would otherwise try to restart it mid-delete);
 * `onDeleted` runs once it is gone, to re-read the list.
 */
export function DeleteSessionDialog({
  session,
  onOpenChange,
  onDeleting,
  onDeleted,
}: {
  /** The session to delete; null keeps the dialog closed. */
  session: { id: string; title: string; deletion: SessionDeletion } | null;
  onOpenChange: (open: boolean) => void;
  onDeleting?: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <ConfirmSessionDialog
      open={session !== null}
      title={`Delete “${session?.title ?? ""}”?`}
      description={session ? `${deletionConsequence(session.deletion)} This can't be undone.` : null}
      busyLabel="Deleting"
      failure="Could not delete this session."
      confirm={(go) => <HoldToConfirm label="Delete session" onConfirm={go} />}
      run={async () => {
        if (!session) return;
        onDeleting?.(session.id);
        await deleteSession(session.id, session.deletion);
      }}
      onOpenChange={onOpenChange}
      onDone={() => {
        if (session) onDeleted(session.id);
      }}
    />
  );
}
