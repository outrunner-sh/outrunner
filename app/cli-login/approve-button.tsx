"use client";

import { useFormStatus } from "react-dom";

import { LoadingButton } from "@/components/ui/loading-button";

/** Submits the approval form it sits in, until the browser goes back to the CLI. */
export function ApproveButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      status={pending ? "pending" : "idle"}
      labels={{ idle: "Sign in the CLI", pending: "Signing in" }}
    />
  );
}
