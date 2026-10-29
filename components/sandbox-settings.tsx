"use client";

import { PageHeader } from "@/components/page-layout";

import { Check, Lock, Pencil, SquareTerminal, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { DaytonaIcon, ModalIcon } from "@/components/brand-icons";
import { type OptionCard, OptionCards } from "@/components/option-cards";
import { ConnectionStatus, DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { KeyInput } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { allowsBoxSize, boxSizeWithin, type Plan } from "@/lib/billing/plans";
import { saveOutcome, type SaveFailure } from "@/lib/settings/save-error";
import type { SandboxChoice, SandboxSettings, StoredKey } from "@/lib/db/credentials";
import { requestJson } from "@/lib/http/request-json";
import { BOX_SIZES, type BoxSizeId } from "@/lib/runtime/box-sizes";
import { modalTokenInText, type ModalToken } from "@/lib/runtime/sandbox/modal-token";
import { cn } from "@/lib/utils";

type OwnSandbox = Exclude<SandboxChoice, "outrunner">;

/** What each sandbox is, for its card and the line under the cards. */
const SANDBOXES: Record<SandboxChoice, { label: string; icon: OptionCard<SandboxChoice>["icon"]; detail: string }> = {
  outrunner: {
    label: "Outrunner",
    icon: OutrunnerMark,
    detail: "Outrunner's own sandboxes, part of your plan. Nothing to set up.",
  },
  daytona: {
    label: "Daytona",
    icon: DaytonaIcon,
    detail: "Your Daytona account, on your API key. Daytona bills you for it.",
  },
  modal: {
    label: "Modal",
    icon: ModalIcon,
    detail:
      "Your Modal account, on your token. Modal bills you for it. Modal ends a sandbox after a day; Outrunner starts it again where it was the next time you open a session.",
  },
};

const ORDER: SandboxChoice[] = ["outrunner", "daytona", "modal"];

/** What a credential change is called when it fails, so the line says which. */
function credentialSubject(sandbox: OwnSandbox): string {
  return `the ${SANDBOXES[sandbox].label} ${sandbox === "modal" ? "token" : "API key"}`;
}

/** Outrunner's mark: its prompt. */
function OutrunnerMark({ className }: { className?: string }) {
  return <SquareTerminal aria-hidden className={className} />;
}

/**
 * Settings → Sandbox: where the user's cloud sessions run, a card each:
 * Outrunner's sandboxes (the default, nothing to set up), their own Daytona
 * on an API key, their own Modal on a token. Each one's credential is saved
 * on its own card, checked with its provider first, so both can be ready;
 * which one new sessions use is picked on purpose, since a switch replaces
 * each project's sandbox.
 */
export function SandboxSettingsForm({
  initial,
  sizes,
  plan,
}: {
  initial: SandboxSettings;
  /** Whether Outrunner's sandboxes can be sized here. */
  sizes: boolean;
  /** The user's plan, which limits the sizes on Outrunner's sandboxes. */
  plan: Plan;
}) {
  const [settings, setSettings] = useState(initial);
  const [shown, setShown] = useState<SandboxChoice>(initial.sandbox);
  const [status, setStatus] = useState<ActionStatus>("idle");
  // The change that didn't land, as its line names it. Cleared by that
  // change's own success, replaced by a newer failure, dismissed by hand.
  const [error, setError] = useState<SaveFailure | null>(null);
  // Changes go out one at a time, in the order made: a save that is still
  // checking a key mustn't land after, and undo, a switch made since. Each
  // names the sandbox in use as it is when it goes out, not when it was made.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inUseNow = useRef(initial.sandbox);
  const busy = status === "pending";

  /** Send a change, after any before it; the answer is the settings as the
   *  server has them. `body` is made as it goes out. A change that fails is
   *  called what it was: a removal isn't a save. */
  function send(subject: string, method: "PUT" | "DELETE", body?: () => object, query = ""): Promise<boolean> {
    setStatus("pending");
    const verb = method === "DELETE" ? "remove" : "save";
    const run = queue.current.then(async () => {
      try {
        const data = await requestJson<SandboxSettings>(`/api/settings/sandbox${query}`, {
          method,
          body: body?.(),
          has: (d) => d.sandbox !== undefined,
          // The line already says "Couldn't <verb> <subject>".
          fallback: "Outrunner didn't say why.",
        });
        inUseNow.current = data.sandbox;
        // What landed clears its own failure — the line names the change, and
        // only that change's success retires it. Anything else that failed is
        // still unmade, whatever just landed.
        setError((current) => saveOutcome(current, { verb, subject, ok: true }));
        setSettings(data);
        setStatus("success");
        return true;
      } catch (e) {
        setError(
          saveOutcome(null, {
            verb,
            subject,
            ok: false,
            // The line already says "Couldn't <verb> <subject>"; the why
            // doesn't say it again.
            message: e instanceof Error ? e.message : "Outrunner didn't say why.",
          }),
        );
        setStatus("error");
        return false;
      }
    });
    queue.current = run;
    return run;
  }

  const inUse = settings.sandbox;
  const ready = (sandbox: SandboxChoice) => sandbox === "outrunner" || settings[sandbox].connected;
  // The size a box really gets on the sandbox in use: on Outrunner's, a saved
  // size beyond the plan is shown as the size new boxes get instead.
  const size = inUse === "outrunner" ? boxSizeWithin(plan, settings.boxSize).id : settings.boxSize;
  // Sized here: Outrunner's sandboxes (where they can be), and the user's own
  // Modal, where every size is theirs to pay for.
  const sized = (sandbox: SandboxChoice) => (sandbox === "outrunner" && sizes) || sandbox === "modal";

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <PageHeader title={"Sandbox"} />
        <p className="text-sm text-muted-foreground">Where your cloud sessions run.</p>
      </div>

      <div className="space-y-3">
        <OptionCards
          options={ORDER.map((id) => ({
            id,
            label: SANDBOXES[id].label,
            icon: SANDBOXES[id].icon,
            connected: id !== "outrunner" && settings[id].connected,
          }))}
          chosen={inUse}
          shown={shown}
          onSelect={(id) => {
            setShown(id);
            // A save still under way keeps saying so. Looking at another card
            // saves nothing: a failure that is still true stays on screen.
            if (!busy) setStatus("idle");
          }}
          label="Sandbox"
          chosenLabel="in use"
        />
        <p className="text-sm text-muted-foreground">{SANDBOXES[shown].detail}</p>
      </div>

      {shown !== "outrunner" ? (
        <SandboxCredential
          // Its own drafts per provider: a Modal secret typed in mustn't
          // turn up in Daytona's field.
          key={shown}
          sandbox={shown}
          stored={settings[shown]}
          inUse={inUse === shown}
          busy={busy}
          onSave={(credential) =>
            send(credentialSubject(shown), "PUT", () => ({ sandbox: inUseNow.current, ...credential }))
          }
          onRemove={() => void send(credentialSubject(shown), "DELETE", undefined, `?key=${shown}`)}
        />
      ) : null}

      {inUse === shown && sized(shown) ? (
        <BoxSizePicker
          value={size}
          onChange={(next) => {
            if (!busy) void send("the new box size", "PUT", () => ({ sandbox: inUseNow.current, boxSize: next }));
          }}
          plan={shown === "outrunner" ? plan : undefined}
        />
      ) : null}

      {inUse !== shown ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-4">
          <p className="text-sm text-muted-foreground">
            {ready(shown)
              ? `New sessions run on ${SANDBOXES[inUse].label} now. Switching applies from your next session in each project: it starts in a new sandbox on ${SANDBOXES[shown].label}, and the project's old sandbox is deleted, with any sessions still in it.`
              : `Save your ${SANDBOXES[shown].label} ${shown === "modal" ? "token" : "API key"} above to run sessions there.`}
          </p>
          <LoadingButton
            variant="outline"
            status={busy ? "pending" : "idle"}
            labels={{ idle: `Use ${SANDBOXES[shown].label} for new sessions` }}
            disabled={!ready(shown) || busy}
            onClick={() => {
              const next = shown;
              void send("the sandbox for new sessions", "PUT", () => ({ sandbox: next }));
            }}
          />
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <Check aria-hidden className="size-4 text-positive" /> New sessions run on {SANDBOXES[shown].label}.
        </p>
      )}

      {error ? (
        <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>
          Couldn&apos;t {error.verb} {error.subject}: {error.message}
        </InlineMessage>
      ) : null}
    </section>
  );
}

/** What a credential save sends: a Daytona key, or a Modal token. */
type CredentialBody = { daytonaKey: string } | { modalToken: ModalToken };

/**
 * One own sandbox's credential: whether it's saved (its last 4, never the
 * key), and the way to save, replace or remove it. Saving doesn't switch
 * sessions to it; removing the one in use moves them back to Outrunner's.
 */
function SandboxCredential({
  sandbox,
  stored,
  inUse,
  busy,
  onSave,
  onRemove,
}: {
  sandbox: OwnSandbox;
  stored: StoredKey;
  inUse: boolean;
  busy: boolean;
  onSave: (credential: CredentialBody) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [key, setKey] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [replacing, setReplacing] = useState(false);
  const modal = sandbox === "modal";
  const what = modal ? "Token" : "API key";
  const asking = !stored.connected || replacing;
  const typed = modal ? tokenId.trim() !== "" && key.trim() !== "" : key.trim() !== "";

  async function save() {
    if (!typed || busy) return;
    const ok = await onSave(
      modal ? { modalToken: { tokenId: tokenId.trim(), tokenSecret: key.trim() } } : { daytonaKey: key.trim() },
    );
    if (ok) {
      setKey("");
      setTokenId("");
      setReplacing(false);
    }
  }
  /** A Modal field's input: pasted `modal token set …` (or `.env` lines) goes
   *  to the fields it has a part for, and the field it was pasted in doesn't
   *  keep the rest; anything else is the field's own value. */
  const modalInput = (field: keyof ModalToken) => (value: string) => {
    const found = modalTokenInText(value);
    if (!found) return field === "tokenId" ? setTokenId(value) : setKey(value);
    if (found.tokenId !== undefined || field === "tokenId") setTokenId(found.tokenId ?? "");
    if (found.tokenSecret !== undefined || field === "tokenSecret") setKey(found.tokenSecret ?? "");
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") void save();
  };

  return (
    <div className="space-y-3">
      <SectionHeader
        title={what}
        link={
          modal
            ? { href: "https://modal.com/settings/tokens", label: "Modal → API Tokens" }
            : { href: "https://app.daytona.io/dashboard/keys", label: "Daytona → API Keys" }
        }
      />
      <ConnectionStatus connected={stored.connected} />
      <Details>
        <DetailRow term="Provider">{modal ? "Modal" : "Daytona"}</DetailRow>
        <DetailRow term="Billing">Your {modal ? "Modal" : "Daytona"} account</DetailRow>
        {modal ? <DetailRow term="Sandboxes">In a Modal App called outrunner</DetailRow> : null}
      </Details>
      {asking ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {modal ? (
              <KeyInput
                value={tokenId}
                onChange={modalInput("tokenId")}
                onKeyDown={onKeyDown}
                placeholder="Token ID (ak-…)"
                label="Modal token ID"
                reveal
              />
            ) : null}
            <KeyInput
              value={key}
              onChange={modal ? modalInput("tokenSecret") : setKey}
              onKeyDown={onKeyDown}
              placeholder={modal ? "Token secret (as-…)" : "Paste your Daytona API key"}
              label={modal ? "Modal token secret" : "Daytona API key"}
            />
            {replacing ? (
              <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            ) : null}
            <LoadingButton
              status={busy ? "pending" : "idle"}
              labels={{ idle: "Save", pending: "Checking" }}
              disabled={!typed}
              onClick={() => void save()}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            It&apos;s checked with {modal ? "Modal" : "Daytona"}, then stored encrypted.
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-4 py-2.5">
          <span className="font-mono text-sm text-muted-foreground">········{stored.hint ?? "····"}</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label={`Replace ${what}`} title={`Replace ${what}`} onClick={() => setReplacing(true)}>
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${what}`}
              title={inUse ? `Remove ${what}: new sessions go back to Outrunner's sandboxes` : `Remove ${what}`}
              disabled={busy}
              onClick={onRemove}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
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
