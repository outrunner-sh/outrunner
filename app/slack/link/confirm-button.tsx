"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";

/** Submits the confirmation form it sits in. */
export function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Connect Slack", pending: "Connecting" }}
    />
  );
}
