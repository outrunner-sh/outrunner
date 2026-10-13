"use client";

import { useState } from "react";
import { Check, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import type { SandboxChoice, SandboxSettings } from "@/lib/db/credentials";
import { BOX_SIZES, type BoxSizeId } from "@/lib/runtime/box-sizes";
import { cn } from "@/lib/utils";

/**
 * Settings → Sandbox: where the user's cloud sessions run. Outrunner's
 * sandboxes are the default and need nothing; their own Daytona needs an API
 * key, which the server checks with Daytona before keeping it.
 */
export function SandboxSettingsForm({
  initial,
  outrunnerRunsOn,
  sizes,
}: {
  initial: SandboxSettings;
  /** What Outrunner's sandboxes are, in a few words ("NeevCloud sandboxes"). */
  outrunnerRunsOn: string;
  /** Whether Outrunner's sandboxes can be sized here. */
  sizes: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [choice, setChoice] = useState<SandboxChoice>(initial.sandbox);
  const [size, setSize] = useState<BoxSizeId>(initial.boxSize);
  const [key, setKey] = useState("");
  // A stored key is only replaced on purpose.
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const askingForKey = choice === "daytona" && (!settings.daytona.connected || replacing);
  const dirty =
    choice !== settings.sandbox ||
    (choice === "outrunner" && size !== settings.boxSize) ||
    (askingForKey && key.trim() !== "");
  const canSave = dirty && !(askingForKey && !key.trim());

  async function send(method: "PUT" | "DELETE", body?: object): Promise<void> {
    setStatus("pending");
    setError(null);
    try {
      const res = await fetch("/api/settings/sandbox", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json()) as SandboxSettings & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save that.");
      setSettings(data);
      setChoice(data.sandbox);
      setSize(data.boxSize);
      setKey("");
      setReplacing(false);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setStatus("error");
    }
  }

  const save = () =>
    void send("PUT", {
      sandbox: choice,
      ...(choice === "outrunner" && sizes ? { boxSize: size } : {}),
      ...(askingForKey && key.trim() ? { daytonaKey: key.trim() } : {}),
    });

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Sandbox</h1>
        <p className="text-sm text-muted-foreground">Where your cloud sessions run.</p>
      </div>

      <div role="radiogroup" aria-label="Sandbox" className="space-y-3">
        <Option
          selected={choice === "outrunner"}
          onSelect={() => {
            setChoice("outrunner");
            setStatus("idle");
          }}
          title="Outrunner's sandbox"
          badge="Default"
          detail={`Runs on ${outrunnerRunsOn}. Nothing to set up.`}
        >
          {choice === "outrunner" && sizes ? (
            <BoxSizePicker
              value={size}
              onChange={(next) => {
                setSize(next);
                setStatus("idle");
              }}
            />
          ) : null}
        </Option>
        <Option
          selected={choice === "daytona"}
          onSelect={() => {
            setChoice("daytona");
            setStatus("idle");
          }}
          title="Your own Daytona"
          detail="Runs in your Daytona account, on your API key, and Daytona bills you for it."
        >
          {choice === "daytona" ? (
            askingForKey ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && canSave && status !== "pending") save();
                    }}
                    placeholder="Paste your Daytona API key"
                    aria-label="Daytona API key"
                    autoComplete="off"
                    spellCheck={false}
                    className="border-border bg-background/60 h-9 flex-1 rounded-md border px-3 text-sm"
                  />
                  {replacing ? (
                    <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
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
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-positive" />
                  <p className="text-sm text-foreground">
                    Key saved
                    {settings.daytona.hint ? (
                      <span className="text-muted-foreground"> · ends ····{settings.daytona.hint}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={status === "pending"}
                    onClick={() => void send("DELETE")}
                  >
                    Remove key
                  </Button>
                </div>
              </div>
            )
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

/** CPU and memory a new sandbox boots with; the locked sizes need a higher plan. */
function BoxSizePicker({ value, onChange }: { value: BoxSizeId; onChange: (size: BoxSizeId) => void }) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">Box size</p>
        <p className="text-xs text-muted-foreground">CPU and memory a new sandbox boots with.</p>
      </div>
      <div role="radiogroup" aria-label="Box size" className="divide-y divide-border/60 rounded-md border border-border/60">
        {BOX_SIZES.map((size) => {
          const selected = size.id === value;
          return (
            <button
              key={size.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={size.locked}
              onClick={() => onChange(size.id)}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed"
            >
              {size.locked ? (
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
              <span className={cn("flex-1 text-sm", size.locked ? "text-muted-foreground" : "text-foreground")}>
                {size.label}
              </span>
              {size.locked ? (
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
        Larger sizes need a higher plan. Applies to new sandboxes; one already running keeps its
        size.
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
