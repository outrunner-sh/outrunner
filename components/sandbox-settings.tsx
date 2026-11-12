"use client";

import { PageHeader } from "@/components/page-layout";

import { Box, Check, Cloud, Copy, Lock, Pencil, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DaytonaIcon, ModalIcon } from "@/components/brand-icons";
import { type OptionCard, OptionCards } from "@/components/option-cards";
import { ConnectionStatus, DetailRow, Details, SectionHeader } from "@/components/settings-details";
import { KeyInput } from "@/components/stored-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { allowsBoxSize, boxSizeWithin, type Plan } from "@/lib/billing/plans";
import { saveOutcome, type SaveFailure } from "@/lib/settings/save-error";
import type { E2bSettings, SandboxChoice, SandboxSettings, StoredKey } from "@/lib/db/credentials";
import { requestJson } from "@/lib/http/request-json";
import { BOX_SIZES, type BoxSizeId } from "@/lib/runtime/box-sizes";
import { modalTokenInText, type ModalToken } from "@/lib/runtime/sandbox/modal-token";
import { cn } from "@/lib/utils";
import { gcpSetupCommand } from "@/lib/runtime/gcp/setup-command";

type OwnSandbox = Exclude<SandboxChoice, "outrunner" | "gcp" | "e2b">;

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
  gcp: {
    label: "Google Cloud",
    icon: Cloud,
    detail: "Private sandbox VMs in your Google Cloud project. Google bills you for compute, retained disks, and networking.",
  },
  modal: {
    label: "Modal",
    icon: ModalIcon,
    detail:
      "Your Modal account, on your token. Modal bills you for it. Modal ends a sandbox after a day; Outrunner starts it again where it was the next time you open a session.",
  },
  e2b: {
    label: "E2B",
    icon: Box,
    detail:
      "Your E2B account, at E2B's cloud or your own self-hosted E2B, on your API key. E2B bills you for it. Sandboxes pause with their memory, so a session resumes exactly where it was.",
  },
};

const ORDER: SandboxChoice[] = ["outrunner", "daytona", "modal", "gcp", "e2b"];

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
  ownerId,
}: {
  initial: SandboxSettings;
  ownerId?: string;
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
  const saveRevision = useRef(0);
  const busy = status === "pending";

  /** Send a change, after any before it; the answer is the settings as the
   *  server has them. `body` is made as it goes out. A change that fails is
   *  called what it was: a removal isn't a save. */
  function send(subject: string, method: "PUT" | "DELETE", body?: () => object, query = ""): Promise<boolean> {
    saveRevision.current += 1;
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

  // Followed while there's something to follow: a Google Cloud setup, or an
  // E2B template being built in the user's account.
  const e2bBuilding = settings.e2b?.connected && (settings.e2b.template === "building" || settings.e2b.template === "outdated" || settings.e2b.template === "none");
  useEffect(() => {
    if (shown !== "gcp" && !(shown === "e2b" && e2bBuilding)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (inUseNow.current !== settings.sandbox) return;
      const revision = saveRevision.current;
      void fetch("/api/settings/sandbox", { signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error("Could not refresh sandbox settings."); return await response.json() as SandboxSettings; })
        .then((data) => { if (!controller.signal.aborted && revision === saveRevision.current && ORDER.includes(data.sandbox)) { setSettings(data); inUseNow.current = data.sandbox; } }).catch(() => {});
    }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [shown, settings.sandbox, e2bBuilding]);

  const inUse = settings.sandbox;
  // E2B is ready once Outrunner's template is built in the user's account.
  const ready = (sandbox: SandboxChoice) =>
    sandbox === "outrunner" || (sandbox === "e2b" ? settings.e2b?.connected && settings.e2b.template === "ready" : settings[sandbox]?.connected);
  // The size a box really gets on the sandbox in use: on Outrunner's, a saved
  // size beyond the plan is shown as the size new boxes get instead.
  const size = inUse === "outrunner" ? boxSizeWithin(plan, settings.boxSize).id : settings.boxSize;
  // Sized here: Outrunner's sandboxes (where they can be), and the user's own
  // Modal, where every size is theirs to pay for.
  const sized = (sandbox: SandboxChoice) => (sandbox === "outrunner" && sizes) || sandbox === "modal" || sandbox === "gcp";

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <PageHeader title={"Sandbox"} />
        <p className="text-sm text-muted-foreground">Where your cloud sessions run.</p>
      </div>

      <div className="space-y-3">
        <OptionCards
          columns={5}
          options={ORDER.map((id) => ({
            id,
            label: SANDBOXES[id].label,
            icon: SANDBOXES[id].icon,
            connected: id !== "outrunner" && settings[id]?.connected,
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

      {shown === "gcp" ? (
        <GcpConnectionCard ownerId={ownerId} stored={settings.gcp} busy={busy} onRemove={() => void send("the Google Cloud connection", "DELETE", undefined, "?key=gcp")} />
      ) : shown === "e2b" ? (
        <E2bConnectionCard
          stored={settings.e2b}
          inUse={inUse === "e2b"}
          busy={busy}
          onSave={(connection) => send("the E2B API key", "PUT", () => ({ sandbox: inUseNow.current, ...connection }))}
          onRebuild={() => void send("the E2B template", "PUT", () => ({ sandbox: inUseNow.current, e2bRebuild: true }))}
          onRemove={() => {
            // It ends every session there: their boxes, and the template
            // built for them, are deleted from the user's E2B as it goes.
            if (window.confirm(E2B_DISCONNECT_WARNING)) void send("the E2B API key", "DELETE", undefined, "?key=e2b");
          }}
        />
      ) : shown !== "outrunner" ? (
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
          gcp={shown === "gcp"}
        />
      ) : null}

      {inUse !== shown ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-4">
          <p className="text-sm text-muted-foreground">
            {ready(shown)
              ? `New sessions run on ${SANDBOXES[inUse].label} now. Switching applies to new sessions. Existing sessions keep their current sandbox.`
              : shown === "gcp"
                ? "Connect your Google Cloud project with the Outrunner CLI to run sessions there."
                : shown === "e2b" && settings.e2b?.connected
                  ? "New sessions can run on your E2B once Outrunner's template is built there."
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

function GcpConnectionCard({ stored, busy, onRemove, ownerId }: { ownerId?: string; stored?: StoredKey; busy: boolean; onRemove: () => void }) {
  const [copied, setCopied] = useState(false);
  const [command, setCommand] = useState("npx outrunner@latest sandbox connect gcp");
  useEffect(() => {
    // Keep a terminal signed into another account from connecting the project
    // there: the existing CLI sign-in flow enforces --account.
    queueMicrotask(() => setCommand(gcpSetupCommand(window.location.origin, ownerId)));
  }, [ownerId]);
  return (
    <div className="space-y-3">
      <SectionHeader title="Google Cloud project" />
      <ConnectionStatus connected={stored?.connected ?? false} />
      <p className="text-sm text-muted-foreground">Run this in your terminal or Google Cloud Shell. Choose a billing-enabled project and approve the setup. The CLI configures access and tests a temporary sandbox; no JSON key is needed.</p>
      <div className="flex items-center gap-2 rounded-lg border border-border/60 p-3">
        <code className="min-w-0 flex-1 break-all text-xs">{command}</code>
        <Button variant="ghost" size="icon" aria-label={copied ? "Command copied" : "Copy setup command"} onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)); }}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      <Details>
        {stored?.connected ? <DetailRow term="Project">{stored.hint}</DetailRow> : null}
        <DetailRow term="Billing">Your Google Cloud account</DetailRow>
        <DetailRow term="Storage">Files survive pause. Retained disks and Cloud NAT continue to incur charges.</DetailRow>
      </Details>
      {stored?.connected ? <Button variant="outline" disabled={busy} onClick={onRemove}>Disconnect Google Cloud</Button> : null}
      <p className="text-xs text-muted-foreground">Requires gcloud and permission to configure your project. Delete this connection&apos;s sessions before disconnecting; remove the dedicated network and IAM resources in Google Cloud to finish teardown.</p>
    </div>
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

/** What disconnecting E2B does, said before it's done. */
export const E2B_DISCONNECT_WARNING =
  "Disconnect your E2B? Outrunner deletes the sandboxes it made in your E2B account, running or paused, " +
  "and the box template it built there, so nothing keeps billing you. Sessions on them end, and their " +
  "unpushed work is lost. Nothing else in your account is touched.";

/** What an E2B save sends: the key, and a self-hosted E2B's URLs (empty for
 *  E2B's cloud). */
type E2bBody = { e2bKey: string; e2bApiUrl: string; e2bSandboxUrl: string };

/** Where Outrunner's template is in the user's E2B, in words. */
const E2B_TEMPLATE_LINE: Record<E2bSettings["template"], string> = {
  none: "Starting to build Outrunner's template in your E2B…",
  building: "Building Outrunner's template in your E2B. This takes a few minutes; you can leave this page.",
  ready: "Outrunner's template is ready in your E2B.",
  failed: "Outrunner's template failed to build in your E2B.",
  outdated: "Outrunner's tools were updated; rebuilding its template in your E2B.",
};

/**
 * The user's own E2B: their API key (its last 4 once saved, never the key),
 * E2B's cloud or a self-hosted E2B's two URLs, and Outrunner's box template,
 * built in their account once the key is saved and followed here to ready.
 */
function E2bConnectionCard({
  stored,
  inUse,
  busy,
  onSave,
  onRebuild,
  onRemove,
}: {
  stored?: E2bSettings;
  inUse: boolean;
  busy: boolean;
  onSave: (connection: E2bBody) => Promise<boolean>;
  onRebuild: () => void;
  onRemove: () => void;
}) {
  const [key, setKey] = useState("");
  const [selfHosted, setSelfHosted] = useState(Boolean(stored?.apiUrl));
  const [apiUrl, setApiUrl] = useState(stored?.apiUrl ?? "");
  const [sandboxUrl, setSandboxUrl] = useState(stored?.sandboxUrl ?? "");
  const [replacing, setReplacing] = useState(false);
  const connected = stored?.connected ?? false;
  const asking = !connected || replacing;
  const typed = key.trim() !== "" && (!selfHosted || (apiUrl.trim() !== "" && sandboxUrl.trim() !== ""));

  async function save() {
    if (!typed || busy) return;
    const ok = await onSave({
      e2bKey: key.trim(),
      e2bApiUrl: selfHosted ? apiUrl.trim() : "",
      e2bSandboxUrl: selfHosted ? sandboxUrl.trim() : "",
    });
    if (ok) {
      setKey("");
      setReplacing(false);
    }
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") void save();
  };

  return (
    <div className="space-y-3">
      <SectionHeader title="API key" link={{ href: "https://e2b.dev/dashboard?tab=keys", label: "E2B → Keys" }} />
      <ConnectionStatus connected={connected} />
      <Details>
        <DetailRow term="Provider">E2B</DetailRow>
        <DetailRow term="Where">{stored?.apiUrl ? new URL(stored.apiUrl).host : "E2B's cloud"}</DetailRow>
        <DetailRow term="Billing">Your E2B account</DetailRow>
        <DetailRow term="Box size">Small · 2 vCPU · 4 GB</DetailRow>
      </Details>
      {connected && stored ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-4 py-2.5">
          <p className="text-sm text-muted-foreground">
            {E2B_TEMPLATE_LINE[stored.template]}
            {stored.template === "failed" && stored.templateError ? ` ${stored.templateError}` : ""}
          </p>
          {stored.template === "failed" ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRebuild}>
              Rebuild
            </Button>
          ) : null}
        </div>
      ) : null}
      {asking ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <KeyInput value={key} onChange={setKey} onKeyDown={onKeyDown} placeholder="Paste your E2B API key (e2b_…)" label="E2B API key" />
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
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={selfHosted} onChange={(event) => setSelfHosted(event.target.checked)} />
            Self-hosted E2B
          </label>
          {selfHosted ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="API URL (https://e2b-api.example.com)"
                aria-label="E2B API URL"
              />
              <Input
                value={sandboxUrl}
                onChange={(event) => setSandboxUrl(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Sandbox URL (https://e2b-sandbox.example.com)"
                aria-label="E2B sandbox URL"
              />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            It&apos;s checked with E2B, then stored encrypted. Outrunner then builds its template (Claude Code, Codex
            and gh) in your E2B account, which takes a few minutes.
            {selfHosted ? " A self-hosted E2B must be reachable over https on a public host." : ""}
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-4 py-2.5">
          <span className="font-mono text-sm text-muted-foreground">········{stored?.hint ?? "····"}</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Replace API key" title="Replace API key" onClick={() => setReplacing(true)}>
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove API key"
              title={inUse ? "Disconnect E2B: deletes Outrunner's sandboxes there; new sessions go back to Outrunner's" : "Disconnect E2B: deletes Outrunner's sandboxes there"}
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
  gcp = false,
}: {
  value: BoxSizeId;
  onChange: (size: BoxSizeId) => void;
  plan?: Plan;
  gcp?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">Box size</p>
        <p className="text-xs text-muted-foreground">CPU and memory a new sandbox boots with.</p>
      </div>
      <div role="radiogroup" aria-label="Box size" className="divide-y divide-border/60 rounded-md border border-border/60">
        {BOX_SIZES.filter((size) => !gcp || size.id !== "x-small").map((size) => {
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
