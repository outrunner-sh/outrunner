"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { requestJson } from "@/lib/http/request-json";

/** Accept an invite: join its org, which the app then shows. */
export function AcceptInvite({ token, orgName }: { token: string; orgName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setPending(true);
    setError(null);
    try {
      await requestJson("/api/invites/accept", {
        method: "POST",
        body: { token },
        fallback: "Couldn't accept the invite. Try again.",
      });
      router.push("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't accept the invite. Try again.");
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <LoadingButton
        status={pending ? "pending" : "idle"}
        labels={{ idle: `Join ${orgName}`, pending: "Joining" }}
        onClick={() => void accept()}
      />
      {error ? <InlineMessage>{error}</InlineMessage> : null}
    </div>
  );
}
