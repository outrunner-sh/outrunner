"use client";

import { ArrowLeft, FileText, KeyRound, Plug, Plus, Settings2, Sparkles, SquareTerminal, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { PageHeader, PageLayout } from "@/components/page-layout";
import { failedLinks, SecretSyncPanel } from "@/components/secret-sync-panel";
import { McpServersSection } from "@/components/project-mcp-servers";
import { DeleteButton, Panel, SectionTitle, useSave } from "@/components/project-section";
import { SkillsSection } from "@/components/project-skills";
import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { SELECT_OPTIONS } from "@/components/ui/select-options";
import { Textarea } from "@/components/ui/textarea";
import type { Environment } from "@/lib/db/environments";
import type { EnvironmentSecretSync } from "@/lib/db/secret-sync";
import { MAX_REPOS, parseDotenv, type SecretsEdit } from "@/lib/environments/rules";
import { requestJson } from "@/lib/http/request-json";
import { newSessionHref } from "@/lib/nav/sidebar";
import { PROVIDER_LABELS } from "@/lib/secret-sync/rules";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "variables", label: "Environment variables", icon: KeyRound },
  { id: "setup", label: "Setup scripts", icon: SquareTerminal },
  { id: "files", label: "Files", icon: FileText },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP servers", icon: Plug },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function isSection(tab: string | null): tab is SectionId {
  return SECTIONS.some((s) => s.id === tab);
}

/**
 * A project's settings page: the
 * project's name and a way to start a session in it, then a section nav
 * beside the section. Everything here is what a new session of the project
 * starts with; a running session keeps what it started with.
 *
 * The section open is the URL's `?tab=` (general when none), so a section
 * can be linked to: "add it under Environment variables".
 *
 * Variables and files are write-only: the page knows their names and paths,
 * never their values, and a change goes out as an edit (set, remove). So
 * are the Doppler and Infisical secrets synced in (`secretSync`, null before
 * its migration): the page knows each link's names at its last sync, and
 * says on every section when one failed.
 */
export function ProjectSettings({
  initial,
  secretSync: initialSync = null,
}: {
  initial: Environment;
  secretSync?: EnvironmentSecretSync | null;
}) {
  const [environment, setEnvironment] = useState(initial);
  const [secretSync, setSecretSync] = useState(initialSync);
  const failed = failedLinks(secretSync);
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const section: SectionId = isSection(tab) ? tab : "general";
  const setSection = (id: SectionId) => router.replace(id === "general" ? pathname : `${pathname}?tab=${id}`, { scroll: false });
  // Sessions start in a repository until a project can hold more than one.
  const repo = environment.repos[0];
  const readOnly = environment.access !== "write";

  return (
    <PageLayout className="space-y-8">
      <Link href="/projects" className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Projects
      </Link>
      <PageHeader
        title={environment.name}
        description="Manage the environment and defaults for new sessions."
        actions={repo && (
          <Button asChild size="sm">
            <Link href={newSessionHref({ kind: "cloud", projectId: repo.projectId })}>
              <Plus /> New session
            </Link>
          </Button>
        )}
      />

      <div className="grid gap-8 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Project settings" className="flex gap-1 overflow-x-auto border-b border-border/60 pb-3 lg:flex-col lg:self-start lg:border-0 lg:pb-0">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-full [&_svg]:size-3.5 [&_svg]:shrink-0",
                section === id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon /> {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 space-y-4">
          {/* Read access: everything shows, nothing changes (the server
              refuses a change too). A disabled fieldset disables every
              field and button in it. */}
          {readOnly && (
            <InlineMessage tone="info">
              You can see this project and start sessions in it, but not change it. Ask an admin of its org for write
              access.
            </InlineMessage>
          )}
          {failed.length > 0 && section !== "variables" && (
            <InlineMessage
              tone="warning"
              actions={[{ label: "View", onClick: () => setSection("variables") }]}
            >
              {failed.map((l) => PROVIDER_LABELS[l.provider]).join(" and ")}&apos;s last sync failed: new sessions start
              without {failed.length > 1 ? "their" : "its"} secrets.
            </InlineMessage>
          )}
          <fieldset disabled={readOnly} className="min-w-0">
            {section === "general" && <GeneralSection environment={environment} onSaved={setEnvironment} />}
            {section === "variables" && (
              <VariablesSection
                environment={environment}
                onSaved={(kept) => setEnvironment((e) => ({ ...e, ...kept }))}
                secretSync={secretSync}
                onSyncChange={setSecretSync}
              />
            )}
            {section === "setup" && <SetupSection environment={environment} onSaved={setEnvironment} />}
            {section === "files" && (
              <FilesSection environment={environment} onSaved={(kept) => setEnvironment((e) => ({ ...e, ...kept }))} />
            )}
            {section === "skills" && <SkillsSection environment={environment} />}
            {section === "mcp" && <McpServersSection environment={environment} />}
          </fieldset>
        </div>
      </div>
    </PageLayout>
  );
}

/** A connected repository that can be added to the project. */
type Addable = { projectId: string; fullName: string; defaultBranch: string };

/** The project's repositories: each cloned into its own folder of a new
 *  session's, added from the owner's connected repositories, up to MAX_REPOS. */
function RepositoriesEditor({ environment, onSaved }: { environment: Environment; onSaved: (e: Environment) => void }) {
  const [adding, setAdding] = useState(false);
  const [addable, setAddable] = useState<Addable[] | null>(null);
  const [picked, setPicked] = useState("");
  const save = useSave();
  const several = environment.repos.length > 1;
  const full = environment.repos.length >= MAX_REPOS;

  const open = async () => {
    setAdding(true);
    if (addable) return;
    const answer = await save.run(() =>
      requestJson<{ repositories: Addable[] }>(`/api/environments/${environment.id}/repos`, { has: (d) => Array.isArray(d.repositories) }),
    );
    if (answer) setAddable(answer.repositories);
  };
  const change = async (method: "POST" | "DELETE", projectId: string) => {
    const saved = await save.run(() =>
      requestJson<Environment>(
        `/api/environments/${environment.id}/repos${method === "DELETE" ? `?projectId=${projectId}` : ""}`,
        { method, body: method === "POST" ? { projectId } : undefined, has: (d) => d.id !== undefined },
      ),
    );
    if (!saved) return;
    onSaved(saved);
    // Removed, it can be added again: the list is fetched anew when opened.
    setAddable((list) => (method === "DELETE" ? null : (list?.filter((r) => r.projectId !== projectId) ?? null)));
    setPicked("");
    // Closed on any change: opened again, it lists what can be added now.
    setAdding(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-0.5">
          <SectionHeader title="Repositories" />
          <p className="text-xs text-muted-foreground">
            {several
              ? "Each is cloned into its own folder of a new session's, all on the session's branch."
              : "Cloned on its default branch. Add more to work on them together in one session."}{" "}
            Up to {MAX_REPOS}.
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" disabled={full} onClick={() => void open()}>
            <Plus /> Add repository
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {environment.repos.map((r) => (
          <li key={r.projectId} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
            <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-foreground">{r.fullName}</span>
            <span className="font-mono text-xs text-muted-foreground">{r.branch ?? r.defaultBranch}</span>
            {several && <span className="ml-auto font-mono text-xs text-muted-foreground">{r.checkoutName}/</span>}
            {several && r.projectId !== environment.defaultForProjectId && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={`Remove ${r.fullName}`}
                title={`Remove ${r.fullName}`}
                onClick={() => void change("DELETE", r.projectId)}
              >
                <X />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <div className="flex items-center gap-2">
          <select
            aria-label="Repository to add"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className={cn("h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground", SELECT_OPTIONS)}
          >
            <option value="">{addable === null ? "Loading repositories…" : addable.length ? "Pick a repository" : "No other connected repositories"}</option>
            {addable?.map((r) => (
              <option key={r.projectId} value={r.projectId}>
                {r.fullName}
              </option>
            ))}
          </select>
          <LoadingButton status={save.status} disabled={!picked} labels={{ idle: "Add" }} onClick={() => void change("POST", picked)} />
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}
      {several && (
        <p className="text-xs text-muted-foreground">
          Sessions open a pull request in each repository they change, from its own row.
        </p>
      )}
      {save.error && <InlineMessage>{save.error}</InlineMessage>}
    </>
  );
}

function patchEnvironment(id: string, body: object): Promise<Environment> {
  return requestJson<Environment>(`/api/environments/${id}`, { method: "PATCH", body, has: (d) => d.id !== undefined });
}

type Kept = Pick<Environment, "envNames" | "filePaths">;

function editSecrets(id: string, edit: SecretsEdit): Promise<Kept> {
  return requestJson<Kept>(`/api/environments/${id}/secrets`, {
    method: "PATCH",
    body: edit,
    has: (d) => Array.isArray(d.envNames),
  });
}

function GeneralSection({ environment, onSaved }: { environment: Environment; onSaved: (e: Environment) => void }) {
  const [name, setName] = useState(environment.name);
  const [description, setDescription] = useState(environment.description ?? "");
  const [instructions, setInstructions] = useState(environment.instructions ?? "");
  const save = useSave();
  const changed =
    name !== environment.name ||
    description !== (environment.description ?? "") ||
    instructions !== (environment.instructions ?? "");

  return (
    <section className="space-y-5">
      <SectionTitle title="General" detail="The essentials for this project." />
      <Panel>
        <div className="space-y-5 p-5">
          <div className="space-y-2">
            <label htmlFor="project-name" className="text-[13px] font-medium">Project name</label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>
          <div className="space-y-2">
            <label htmlFor="project-description" className="text-[13px] font-medium">Description <span className="font-normal text-muted-foreground">(optional)</span></label>
            <Input
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description"
              aria-label="Description"
              maxLength={500}
            />
          </div>
        </div>
      </Panel>
      <Panel>
        <div className="space-y-4 p-5">
          <RepositoriesEditor environment={environment} onSaved={onSaved} />
        </div>
      </Panel>
      <Panel>
        <div className="space-y-3 p-5">
          <div className="space-y-0.5">
            <SectionHeader title="Instructions" />
            <p className="text-xs text-muted-foreground">Given to the agent in every session, after your own CLAUDE.md.</p>
          </div>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. Use pnpm. Run pnpm test before opening a PR."
            aria-label="Instructions"
            className="min-h-32 font-mono text-xs"
          />
        </div>
      </Panel>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {save.error && <InlineMessage>{save.error}</InlineMessage>}
        <LoadingButton
          status={save.status}
          disabled={!changed}
          labels={{ idle: "Save", success: "Saved" }}
          onClick={async () => {
            const saved = await save.run(() =>
              patchEnvironment(environment.id, { name, description: description || null, instructions: instructions || null }),
            );
            if (saved) onSaved(saved);
          }}
        />
      </div>
    </section>
  );
}

function VariablesSection({
  environment,
  onSaved,
  secretSync,
  onSyncChange,
}: {
  environment: Environment;
  onSaved: (kept: Kept) => void;
  secretSync: EnvironmentSecretSync | null;
  onSyncChange: (sync: EnvironmentSecretSync) => void;
}) {
  const [text, setText] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const save = useSave();
  const parsed = parseDotenv(text);
  const count = Object.keys(parsed.env).length;

  async function send(edit: SecretsEdit) {
    const kept = await save.run(() => editSecrets(environment.id, edit));
    if (kept) onSaved(kept);
    return kept;
  }

  return (
    <section className="space-y-5">
      <SectionTitle
        title="Environment variables"
        detail="Encrypted, and exported in every new session of the project. Values can't be read back once saved."
      />
      <Panel>
        <div className="space-y-3 p-4">
          <SectionHeader title="Add or replace" />
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Paste a .env, or KEY=VALUE lines\nAPI_TOKEN=..."}
            aria-label="Variables to add"
            spellCheck={false}
            autoComplete="off"
            className="min-h-28 font-mono text-xs [-webkit-text-security:disc] focus:[-webkit-text-security:none]"
          />
          {skipped.length > 0 && (
            <InlineMessage tone="warning">
              {skipped.length === 1 ? "1 line isn't" : `${skipped.length} lines aren't`} a variable and was left out.
            </InlineMessage>
          )}
          <div className="flex items-center justify-end gap-3">
            {save.error && <InlineMessage>{save.error}</InlineMessage>}
            <LoadingButton
              status={save.status}
              disabled={count === 0}
              labels={{ idle: count > 1 ? `Save ${count} variables` : "Save variable", success: "Saved" }}
              onClick={async () => {
                setSkipped(parsed.skipped);
                if (await send({ setEnv: parsed.env })) setText("");
              }}
            />
          </div>
        </div>
        {environment.envNames.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No variables yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {environment.envNames.map((name) => (
              <li key={name} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
                <span className="font-mono text-xs text-foreground">{name}</span>
                <span className="flex items-center gap-3">
                  <span aria-hidden className="font-mono text-xs text-muted-foreground">••••••••</span>
                  <DeleteButton what={name} onDelete={() => send({ removeEnv: [name] })} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {secretSync && (
        <SecretSyncPanel
          environmentId={environment.id}
          sync={secretSync}
          ownNames={environment.envNames}
          onChange={onSyncChange}
        />
      )}
    </section>
  );
}

/** Where the project's ready boxes stand, from its warm hook's last run:
 *  ready, being made, or failed. */
function warmState(environment: Environment): { tone: "ready" | "applying" | "failed" | "none"; text: string } {
  const run = environment.warm;
  if (!environment.hooks.warm) return { tone: "none", text: "No warm hook: new sessions start from a plain checkout." };
  if (!run || run.generation !== environment.setupGeneration) {
    return { tone: "applying", text: "Applying: ready boxes are being made with these changes." };
  }
  if (run.status === "running") return { tone: "applying", text: "Applying: the warm hook is running." };
  if (run.status === "failed") return { tone: "failed", text: "Needs attention: the warm hook failed on the ready boxes. New sessions run it themselves as they start." };
  return { tone: "ready", text: `Ready: the warm hook succeeded${run.finishedAt ? ` ${relativeTime(run.finishedAt)}` : ""}.` };
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function SetupSection({ environment, onSaved }: { environment: Environment; onSaved: (e: Environment) => void }) {
  const status = warmState(environment);
  const [showLog, setShowLog] = useState(false);
  const retry = useSave();
  return (
    <section className="space-y-5">
      <SectionTitle
        title="Setup scripts"
        detail="The warm hook prepares sessions ahead of time. The start hook runs each time a session's agent starts."
      />
      <div className="space-y-2 rounded-lg border border-border/60 px-4 py-3 text-[13px]">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                status.tone === "ready" && "bg-positive",
                status.tone === "applying" && "bg-warning",
                status.tone === "failed" && "bg-destructive",
                status.tone === "none" && "bg-muted-foreground/50",
              )}
            />
            <span className="text-foreground/80">{status.text}</span>
          </span>
          <span className="flex items-center gap-2">
            {environment.warm?.log && (
              <Button size="xs" variant="ghost" onClick={() => setShowLog((v) => !v)}>
                {showLog ? "Hide log" : "View log"}
              </Button>
            )}
            {status.tone === "failed" && (
              <LoadingButton
                size="sm"
                variant="outline"
                status={retry.status}
                labels={{ idle: "Try again" }}
                onClick={async () => {
                  const saved = await retry.run(() =>
                    requestJson<Environment>(`/api/environments/${environment.id}/warm`, {
                      method: "POST",
                      has: (d) => d.id !== undefined,
                    }),
                  );
                  if (saved) onSaved(saved);
                }}
              />
            )}
          </span>
        </div>
        {retry.error && <InlineMessage>{retry.error}</InlineMessage>}
        {showLog && environment.warm?.log && (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap text-foreground/80">
            {environment.warm.log}
          </pre>
        )}
      </div>
      <Panel>
        <ScriptEditor
          title="Warm hook"
          detail="Runs ahead of time on the project's ready boxes, in a checkout of the repository with the project's variables and files, before any session takes one: dependency installs, builds. Its work (node_modules, build output) is kept for the session. Up to an hour. Changing it makes the ready boxes again."
          placeholder={"#!/bin/bash\n# e.g. pnpm install"}
          value={environment.hooks.warm}
          save={(warm) => patchEnvironment(environment.id, { hooks: { warm } })}
          onSaved={onSaved}
        />
        <ScriptEditor
          title="Start hook"
          detail="Runs in the session's checkout each time its agent starts, after the warm hook: keep it quick. Its output is in the session's setup log."
          placeholder={"#!/bin/bash\n# e.g. docker compose up -d db"}
          value={environment.hooks.start}
          save={(start) => patchEnvironment(environment.id, { hooks: { start } })}
          onSaved={onSaved}
        />
        {environment.scripts.setup !== null && (
          <ScriptEditor
            title="Session setup script"
            detail="Imported from Conductor: runs once in each new session's checkout, after the warm hook. Move what it does into the warm or start hook, then clear it."
            placeholder=""
            value={environment.scripts.setup}
            save={(setup) => patchEnvironment(environment.id, { scripts: { setup } })}
            onSaved={onSaved}
          />
        )}
      </Panel>
    </section>
  );
}

/** One script: its editor and Save. */
function ScriptEditor({
  title,
  detail,
  placeholder,
  value,
  save: send,
  onSaved,
}: {
  title: string;
  detail: string;
  placeholder: string;
  value: string | null;
  save: (value: string | null) => Promise<Environment>;
  onSaved: (e: Environment) => void;
}) {
  const [text, setText] = useState(value ?? "");
  const save = useSave();
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-0.5">
        <SectionHeader title={title} />
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={title}
        spellCheck={false}
        className="min-h-36 font-mono text-xs"
      />
      <div className="flex items-center justify-end gap-3">
        {save.error && <InlineMessage>{save.error}</InlineMessage>}
        <LoadingButton
          status={save.status}
          disabled={text === (value ?? "")}
          labels={{ idle: "Save", success: "Saved" }}
          onClick={async () => {
            const saved = await save.run(() => send(text || null));
            if (saved) onSaved(saved);
          }}
        />
      </div>
    </div>
  );
}

function FilesSection({ environment, onSaved }: { environment: Environment; onSaved: (kept: Kept) => void }) {
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const save = useSave();

  async function send(edit: SecretsEdit) {
    const kept = await save.run(() => editSecrets(environment.id, edit));
    if (kept) onSaved(kept);
    return kept;
  }

  return (
    <section className="space-y-5">
      <SectionTitle
        title="Files"
        detail="Files the repository keeps out of git, such as .env files, encrypted. A new session gets them in its checkout at their path; with a setup script, the script finds them under $CONDUCTOR_ROOT_PATH instead."
      />
      <Panel>
        <div className="space-y-3 p-4">
          <SectionHeader title="Add or replace a file" />
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Path in the repository, e.g. apps/api/.env"
            aria-label="File path"
            className="font-mono text-xs"
          />
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Its contents"
            aria-label="File contents"
            spellCheck={false}
            autoComplete="off"
            className="min-h-28 font-mono text-xs"
          />
          <div className="flex items-center justify-end gap-3">
            {save.error && <InlineMessage>{save.error}</InlineMessage>}
            <LoadingButton
              status={save.status}
              disabled={path.trim() === ""}
              labels={{ idle: "Save file", success: "Saved" }}
              onClick={async () => {
                if (await send({ setFiles: { [path.trim()]: content } })) {
                  setPath("");
                  setContent("");
                }
              }}
            />
          </div>
        </div>
        {environment.filePaths.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No files yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {environment.filePaths.map((p) => (
              <li key={p} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
                <span className="font-mono text-xs text-foreground">{p}</span>
                <DeleteButton what={p} onDelete={() => send({ removeFiles: [p] })} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
