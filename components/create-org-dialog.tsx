"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import { orgName } from "@/lib/orgs/active";
import { reachOutrunner, requestJson } from "@/lib/http/request-json";

/**
 * Make a team org, named here. It claims the domain of the user's primary
 * verified GitHub email; when an org has that domain already, the server says
 * so and none is made: the person asks that org's admins to invite them.
 * Made, it becomes the org the app shows.
 */
export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An org has the user's domain already: they can ask to join it instead.
  const [domainOrg, setDomainOrg] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const valid = orgName(name) !== null;

  const close = () => {
    setName("");
    setError(null);
    setDomainOrg(null);
    setAsked(null);
    onOpenChange(false);
  };

  const askToJoin = async () => {
    setPending(true);
    setError(null);
    try {
      const data = await requestJson<{ message: string }>("/api/orgs/join-requests", {
        method: "POST",
        has: (d) => typeof d.message === "string",
        fallback: "Couldn't send your request. Try again.",
      });
      setAsked(data.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send your request. Try again.");
    } finally {
      setPending(false);
    }
  };

  const create = async () => {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await reachOutrunner("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        org?: { name?: string };
      } | null;
      if (!response.ok) {
        setError(data?.error ?? "Couldn't make the org. Try again.");
        setDomainOrg(data?.code === "domain_org_exists" ? (data.org?.name ?? "that org") : null);
        return;
      }
      close();
      router.push("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make the org. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-sm gap-5">
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">New team org</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            You&apos;ll be its admin. It takes the domain of your primary GitHub email (unless it&apos;s a free one
            like gmail.com), so teammates from it find this org rather than making another.
          </DialogDescription>
        </div>
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
          placeholder="Acme"
          aria-label="Org name"
          maxLength={80}
          autoComplete="off"
        />
        {asked ? (
          <InlineMessage tone="info">{asked}</InlineMessage>
        ) : error ? (
          <InlineMessage
            actions={
              domainOrg ? [{ label: `Ask to join ${domainOrg}`, onClick: () => void askToJoin() }] : undefined
            }
          >
            {domainOrg ? `${domainOrg} already uses Outrunner for your email's domain. Ask its admins to let you in.` : error}
          </InlineMessage>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={close} className="route-state-button">
            {asked ? "Done" : "Cancel"}
          </button>
          {asked || domainOrg ? null : (
            <button type="button" onClick={() => void create()} disabled={!valid || pending} className="route-state-button">
              {pending ? "Making…" : "Make org"}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
