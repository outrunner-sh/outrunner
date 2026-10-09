"use client";

import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { teamRequest } from "@/lib/teams/client";

/** Join the workspace and switch to it. */
export function AcceptInvite({ token, teamName }: { token: string; teamName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await teamRequest("POST", "/api/invites/accept", { token });
            router.push("/");
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="animate-spin" />} Join {teamName}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
