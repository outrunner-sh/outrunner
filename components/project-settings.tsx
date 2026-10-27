"use client";

import { FileText, KeyRound, Plus, Settings2, SquareTerminal, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import type { Environment } from "@/lib/db/environments";
import { MAX_REPOS, parseDotenv, type SecretsEdit } from "@/lib/environments/rules";
import { requestJson } from "@/lib/http/request-json";
import { newSessionHref } from "@/lib/nav/sidebar";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "variables", label: "Environment variables", icon: KeyRound },
  { id: "setup", label: "Setup script", icon: SquareTerminal },
  { id: "files", label: "Files", icon: FileText },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function isSection(tab: string | null): tab is SectionId {
  return SECTIONS.some((s) => s.id === tab);
}

/**
 * A project's settings page, laid out as Replicas' environment page: the
 * project's name and a way to start a session in it, then a section nav
 * beside the section. Everything here is what a new session of the project
 * starts with; a running session keeps what it started with.
 *
 * The section open is the URL's `?tab=` (general when none), so a section
 * can be linked to: "add it under Environment variables".
 *
 * Variables and files are write-only: the page knows their names and paths,
 * never their values, and a change goes out as an edit (set, remove).
 */
export function ProjectSettings({ initial }: { initial: Environment }) {
  const [environment, setEnvironment] = useState(initial);
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const section: SectionId = isSection(tab) ? tab : "general";
  const setSection = (id: SectionId) => router.replace(id === "general" ? pathname : `${pathname}?tab=${id}`, { scroll: false });
  // Sessions start in a repository until a project can hold more than one.
  const repo = environment.repos[0];

  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-lg font-semibold text-foreground">{environment.name}</h1>
            <p className="text-[13px] text-muted-foreground">
              {environment.description ?? "New sessions in this project start with everything below."}
            </p>
          </div>
          {repo && (
            <Button asChild size="sm">
              <Link href={newSessionHref({ kind: "cloud", projectId: repo.projectId })}>
                <Plus /> New session
              </Link>
            </Button>
          )}
        </header>

        <div className="grid grid-cols-[200px_1fr] gap-8">
          <nav aria-label="Project settings" className="space-y-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={section === id ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] [&_svg]:size-3.5",
                  section === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon /> {label}
              </button>
            ))}
          </nav>
          <main className="min-w-0">
            {section === "general" && <GeneralSection environment={environment} onSaved={setEnvironment} />}
            {section === "variables" && (
              <VariablesSection
                environment={environment}
                onSaved={(kept) => setEnvironment((e) => ({ ...e, ...kept }))}
              />
            )}
            {section === "setup" && <SetupSection environment={environment} onSaved={setEnvironment} />}
            {section === "files" && (
              <FilesSection environment={environment} onSaved={(kept) => setEnvironment((e) => ({ ...e, ...kept }))} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/** A section's title and what it holds, as the settings pages head theirs. */
function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-[13px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/** A bordered panel of rows, as Replicas' sections are. */
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border/60 rounded-lg border border-border/60">{children}</div>;
}

/** Delete a variable or a file: a trash button that turns into a hold, since
 *  a value deleted can't be had back. */
function DeleteButton({ what, onDelete }: { what: string; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Delete ${what}`}
        title={`Delete ${what}`}
        className="text-muted-foreground"
        onClick={() => setConfirming(true)}
      >
        <Trash2 />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <HoldToConfirm label="Delete" onConfirm={onDelete} className="h-7 px-2.5 text-xs" />
      <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** A save's state: its button's, and why it failed. */
function useSave() {
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  async function run<T>(send: () => Promise<T>): Promise<T | null> {
    setStatus("pending");
    setError(null);
    try {
      const result = await send();
      setStatus("success");
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setStatus("error");
      return null;
    }
  }
  return { status, error, run };
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
      <SectionTitle title="General" detail="Repositories, instructions and the project's name." />
      <Panel>
        <div className="space-y-3 p-4">
          <SectionHeader title="Name" />
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" maxLength={80} />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a description"
            aria-label="Description"
            maxLength={500}
          />
        </div>
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <SectionHeader title="Repositories" />
              <p className="text-xs text-muted-foreground">
                Cloned on their default branch unless another is set. Up to {MAX_REPOS} per project.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled
              title="Projects with more than one repository are coming soon."
            >
              <Plus /> Add repository
            </Button>
          </div>
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {environment.repos.map((r) => (
              <li key={r.projectId} className="flex items-center gap-2.5 px-3 py-2.5 text-[13px]">
                <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-foreground">{r.fullName}</span>
                <span className="font-mono text-xs text-muted-foreground">{r.branch ?? r.defaultBranch}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-3 p-4">
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
      <div className="flex items-center justify-end gap-3">
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

function VariablesSection({ environment, onSaved }: { environment: Environment; onSaved: (kept: Kept) => void }) {
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
    </section>
  );
}

function SetupSection({ environment, onSaved }: { environment: Environment; onSaved: (e: Environment) => void }) {
  const [setup, setSetup] = useState(environment.scripts.setup ?? "");
  const save = useSave();
  return (
    <section className="space-y-5">
      <SectionTitle
        title="Setup script"
        detail="Runs once in a new session's checkout when it first starts, with the project's variables and files. Its output is in the session's setup log."
      />
      <Panel>
        <div className="space-y-3 p-4">
          <Textarea
            value={setup}
            onChange={(e) => setSetup(e.target.value)}
            placeholder={"#!/bin/bash\n# e.g. pnpm install"}
            aria-label="Setup script"
            spellCheck={false}
            className="min-h-48 font-mono text-xs"
          />
          <div className="flex items-center justify-end gap-3">
            {save.error && <InlineMessage>{save.error}</InlineMessage>}
            <LoadingButton
              status={save.status}
              disabled={setup === (environment.scripts.setup ?? "")}
              labels={{ idle: "Save", success: "Saved" }}
              onClick={async () => {
                const saved = await save.run(() => patchEnvironment(environment.id, { scripts: { setup: setup || null } }));
                if (saved) onSaved(saved);
              }}
            />
          </div>
        </div>
      </Panel>
    </section>
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
