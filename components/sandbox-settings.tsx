"use client";

import { useState } from "react";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { KeyInput, SavedKey } from "@/components/stored-key";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { allowsBoxSize, boxSizeWithin, type Plan } from "@/lib/billing/plans";
import type { SandboxChoice, SandboxSettings } from "@/lib/db/credentials";
import { BOX_SIZES, type BoxSizeId } from "@/lib/runtime/box-sizes";
import { cn } from "@/lib/utils";

type OwnSandbox = Exclude<SandboxChoice, "outrunner">;

/**
 * Settings → Sandbox: where the user's cloud sessions run. Outrunner's
 * sandboxes are the default and need nothing; their own Daytona needs an API
 * key and their own Modal a token, which the server checks with the provider
 * before keeping it.
 */
export function SandboxSettingsForm({
  initial,
  outrunnerRunsOn,
  sizes,
  plan,
}: {
  initial: SandboxSettings;
  /** What Outrunner's sandboxes are, in a few words ("NeevCloud sandboxes"). */
  outrunnerRunsOn: string;
  /** Whether Outrunner's sandboxes can be sized here. */
  sizes: boolean;
  /** The user's plan, which limits the sizes on Outrunner's sandboxes. */
  plan: Plan;
}) {
  // The size a box really gets on the sandbox chosen: on Outrunner's, a saved
  // size beyond the plan is shown as the size new boxes get instead.
  const effectiveSize = (sandbox: SandboxChoice, saved: BoxSizeId) =>
    sandbox === "outrunner" ? boxSizeWithin(plan, saved).id : saved;
  const [settings, setSettings] = useState(initial);
  const [choice, setChoice] = useState<SandboxChoice>(initial.sandbox);
  const [size, setSize] = useState<BoxSizeId>(effectiveSize(initial.sandbox, initial.boxSize));
  const [daytonaKey, setDaytonaKey] = useState("");
  const [modalId, setModalId] = useState("");
  const [modalSecret, setModalSecret] = useState("");
  // A stored key is only replaced on purpose.
  const [replacing, setReplacing] = useState<OwnSandbox | null>(null);
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const asking = (sandbox: OwnSandbox) => choice === sandbox && (!settings[sandbox].connected || replacing === sandbox);
  const typedDaytona = daytonaKey.trim() !== "";
  const typedModal = modalId.trim() !== "" && modalSecret.trim() !== "";
  // Sized here: Outrunner's sandboxes (where they can be), and the user's own
  // Modal, where every size is theirs to pay for.
  const sized = (choice === "outrunner" && sizes) || choice === "modal";
  const dirty =
    choice !== settings.sandbox ||
    (sized && size !== effectiveSize(choice, settings.boxSize)) ||
    (asking("daytona") && typedDaytona) ||
    (asking("modal") && typedModal);
  const canSave = dirty && !(asking("daytona") && !typedDaytona) && !(asking("modal") && !typedModal);

  async function send(method: "PUT" | "DELETE", body?: object, query = ""): Promise<void> {
    setStatus("pending");
    setError(null);
    try {
      const res = await fetch(`/api/settings/sandbox${query}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      // A reply that isn't JSON (a proxy's error page) says nothing worth showing.
      const data = (await res.json().catch(() => null)) as (SandboxSettings & { error?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.error ?? "Couldn't save that. Try again.");
      setSettings(data);
      setChoice(data.sandbox);
      setSize(effectiveSize(data.sandbox, data.boxSize));
      setDaytonaKey("");
      setModalId("");
      setModalSecret("");
      setReplacing(null);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setStatus("error");
    }
  }

  const save = () =>
    void send("PUT", {
      sandbox: choice,
      ...(sized ? { boxSize: size } : {}),
      ...(asking("daytona") && typedDaytona ? { daytonaKey: daytonaKey.trim() } : {}),
      ...(asking("modal") && typedModal
        ? { modalToken: { tokenId: modalId.trim(), tokenSecret: modalSecret.trim() } }
        : {}),
    });
  const saveOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && canSave && status !== "pending") save();
  };

  function choose(next: SandboxChoice) {
    setChoice(next);
    // A size beyond the plan, chosen for Modal, can't be Outrunner's.
    setSize(effectiveSize(next, size));
    setStatus("idle");
  }

  function changeSize(next: BoxSizeId) {
    setSize(next);
    setStatus("idle");
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Sandbox</h1>
        <p className="text-sm text-muted-foreground">Where your cloud sessions run.</p>
      </div>

      <div role="radiogroup" aria-label="Sandbox" className="space-y-3">
        <Option
          selected={choice === "outrunner"}
          onSelect={() => choose("outrunner")}
          title="Outrunner's sandbox"
          badge="Default"
          detail={`Runs on ${outrunnerRunsOn}. Nothing to set up.`}
        >
          {choice === "outrunner" && sizes ? <BoxSizePicker value={size} onChange={changeSize} plan={plan} /> : null}
        </Option>
        <Option
          selected={choice === "daytona"}
          onSelect={() => choose("daytona")}
          title="Your own Daytona"
          detail="Runs in your Daytona account, on your API key, and Daytona bills you for it."
        >
          {choice === "daytona" ? (
            asking("daytona") ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <KeyInput
                    value={daytonaKey}
                    onChange={setDaytonaKey}
                    onKeyDown={saveOnEnter}
                    placeholder="Paste your Daytona API key"
                    label="Daytona API key"
                  />
                  {replacing === "daytona" ? (
                    <Button variant="ghost" size="sm" onClick={() => setReplacing(null)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Create one in{" "}
                  <a
                    href="https://app.daytona.io/dashboard/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    Daytona → API Keys
                  </a>
                  . It&apos;s checked with Daytona, then stored encrypted.
                </p>
              </div>
            ) : (
              <SavedKey
                what="Key"
                stored={settings.daytona}
                busy={status === "pending"}
                onReplace={() => setReplacing("daytona")}
                onRemove={() => void send("DELETE", undefined, "?key=daytona")}
              />
            )
          ) : null}
        </Option>
        <Option
          selected={choice === "modal"}
          onSelect={() => choose("modal")}
          title="Your own Modal"
          detail="Runs in your Modal account, on your token, and Modal bills you for it. Modal ends a sandbox after a day; Outrunner starts it again where it was the next time you open a session."
        >
          {choice === "modal" ? (
            <div className="space-y-4">
              {asking("modal") ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyInput
                      value={modalId}
                      onChange={setModalId}
                      onKeyDown={saveOnEnter}
                      placeholder="Token ID (ak-…)"
                      label="Modal token ID"
                      reveal
                    />
                    <KeyInput
                      value={modalSecret}
                      onChange={setModalSecret}
                      onKeyDown={saveOnEnter}
                      placeholder="Token secret (as-…)"
                      label="Modal token secret"
                    />
                    {replacing === "modal" ? (
                      <Button variant="ghost" size="sm" onClick={() => setReplacing(null)}>
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Create one in{" "}
                    <a
                      href="https://modal.com/settings/tokens"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      Modal → Settings → API Tokens
                    </a>
                    . It&apos;s checked with Modal, then stored encrypted. Sandboxes go in an App
                    called outrunner.
                  </p>
                </div>
              ) : (
                <SavedKey
                  what="Token"
                  stored={settings.modal}
                  busy={status === "pending"}
                  onReplace={() => setReplacing("modal")}
                  onRemove={() => void send("DELETE", undefined, "?key=modal")}
                />
              )}
              <BoxSizePicker value={size} onChange={changeSize} />
            </div>
          ) : null}
        </Option>
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="max-w-prose text-xs text-muted-foreground">
          A change applies from your next session in each project: it starts in a new sandbox
          where you chose, and the project&apos;s old sandbox is deleted, with any sessions still
          in it.
        </p>
        <LoadingButton
          status={status}
          labels={{ idle: "Save", pending: "Saving", success: "Saved" }}
          disabled={!canSave}
          onClick={save}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** CPU and memory a new sandbox boots with. On Outrunner's, sizes beyond
 *  `plan` need a higher one; on the user's own account (no plan) every size is
 *  theirs. */
function BoxSizePicker({
  value,
  onChange,
  plan,
}: {
  value: BoxSizeId;
  onChange: (size: BoxSizeId) => void;
  plan?: Plan;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">Box size</p>
        <p className="text-xs text-muted-foreground">CPU and memory a new sandbox boots with.</p>
      </div>
      <div role="radiogroup" aria-label="Box size" className="divide-y divide-border/60 rounded-md border border-border/60">
        {BOX_SIZES.map((size) => {
          const selected = size.id === value;
          const locked = plan !== undefined && !allowsBoxSize(plan, size.id);
          return (
            <button
              key={size.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={locked}
              onClick={() => onChange(size.id)}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed"
            >
              {locked ? (
                <Lock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-foreground" : "border-muted-foreground/60",
                  )}
                >
                  {selected ? <span className="size-2 rounded-full bg-foreground" /> : null}
                </span>
              )}
              <span className={cn("flex-1 text-sm", locked ? "text-muted-foreground" : "text-foreground")}>
                {size.label}
              </span>
              {locked ? (
                <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Higher plan
                </span>
              ) : null}
              <span className="font-mono text-xs text-muted-foreground">
                {size.cpu} vCPU · {size.memoryGb} GB
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {plan ? "Larger sizes need a higher plan. " : "Billed by your provider at its rates. "}
        Applies to new sandboxes; one already running keeps its size.
      </p>
    </div>
  );
}

function Option({
  selected,
  onSelect,
  title,
  badge,
  detail,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors",
        selected ? "border-foreground/40 bg-accent/40" : "border-border/60",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex w-full cursor-pointer items-start gap-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-foreground" : "border-muted-foreground/60",
          )}
        >
          {selected ? <span className="size-2 rounded-full bg-foreground" /> : null}
        </span>
        <span className="space-y-1">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            {title}
            {badge ? (
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                {badge}
              </span>
            ) : null}
          </span>
          <span className="block text-sm text-muted-foreground">{detail}</span>
        </span>
      </button>
      {children ? <div className="mt-4 pl-7">{children}</div> : null}
    </div>
  );
}
