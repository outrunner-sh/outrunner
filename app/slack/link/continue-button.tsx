"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";

/** Submits the form it sits in, until the browser goes to Slack. */
export function ContinueButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Continue with Slack", pending: "Opening Slack" }}
    />
  );
}
