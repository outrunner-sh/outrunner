"use client";

import { ExternalLink, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { Panel, SectionTitle, useSave } from "@/components/project-section";
import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import type { Environment } from "@/lib/db/environments";
import type { EnvironmentSkill, SkillRegistry } from "@/lib/db/environment-skills";
import { MAX_REGISTRIES, MAX_SKILLS } from "@/lib/environments/skills";
import type { CatalogResult, CommittedItem, ListedSkill } from "@/lib/github/skills";
import { requestJson } from "@/lib/http/request-json";

type ListedRegistry = SkillRegistry & { skills: ListedSkill[]; error: string | null };
type RepoItem = CommittedItem & { fullName: string; branch: string };

/**
 * A project's skills, as Replicas' environment page has them: skills picked
 * from the skills.sh catalog, GitHub repositories kept as registries (every
 * skill in one installs), and, read-only, the ones its repositories commit,
 * which a session gets with its checkout. A new session's box installs the
 * first two for Claude Code and Codex alike.
 *
 * Nothing here is part of the Environment the page was given: each list is
 * fetched when the section opens, the registries' and repositories' from
 * GitHub, so they come after.
 */
export function SkillsSection({ environment }: { environment: Environment }) {
  const [skills, setSkills] = useState<EnvironmentSkill[] | null>(null);
  const [registries, setRegistries] = useState<ListedRegistry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const base = `/api/environments/${environment.id}`;

  useEffect(() => {
    let live = true;
    requestJson<{ skills: EnvironmentSkill[] }>(`${base}/skills`, { has: (d) => Array.isArray(d.skills), fallback: "Couldn't load the skills." })
      .then((d) => live && setSkills(d.skills))
      .catch((e: Error) => live && setLoadError(e.message));
    requestJson<{ registries: ListedRegistry[] }>(`${base}/skill-registries`, {
      has: (d) => Array.isArray(d.registries),
      fallback: "Couldn't load the registries.",
    })
      .then((d) => live && setRegistries(d.registries))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [base]);

  return (
    <section className="space-y-5">
      <SectionTitle
        title="Skills"
        detail="Installed in every new session of the project, for Claude Code (~/.claude/skills) and Codex (~/.agents/skills). A skill of your own by the same name is kept instead."
      />
      {loadError && <InlineMessage>{loadError}</InlineMessage>}
      <Panel>
        <CatalogSkills base={base} skills={skills} onChange={setSkills} />
        <Registries base={base} registries={registries} onChange={setRegistries} />
      </Panel>
      <RepositorySkills base={base} />
    </section>
  );
}

/** The catalog: a search, and the skills enabled from it. */
function CatalogSkills({
  base,
  skills,
  onChange,
}: {
  base: string;
  skills: EnvironmentSkill[] | null;
  onChange: (skills: EnvironmentSkill[]) => void;
}) {
  const [query, setQuery] = useState("");
  // The last answer: shown while the box holds a search, the next one's in
  // place of it as it comes.
  const [found, setFound] = useState<CatalogResult[] | null>(null);
  const results = query.trim().length >= 2 ? found : null;
  const [searchError, setSearchError] = useState<string | null>(null);
  const save = useSave();
  const enabled = new Set(skills?.map((s) => s.slug));
  const full = (skills?.length ?? 0) >= MAX_SKILLS;

  // Searched as typed, once typing pauses: the catalog is a network away.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      requestJson<{ skills: CatalogResult[] }>(`/api/skills/search?${new URLSearchParams({ q })}`, {
        has: (d) => Array.isArray(d.skills),
        fallback: "Couldn't search the catalog.",
      })
        .then((d) => {
          if (!live) return;
          setFound(d.skills);
          setSearchError(null);
        })
        .catch((e: Error) => live && setSearchError(e.message));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const enable = async (result: CatalogResult) => {
    const answer = await save.run(() =>
      requestJson<{ skill: EnvironmentSkill }>(`${base}/skills`, {
        method: "POST",
        body: { name: result.name, slug: result.slug, source: result.source },
        has: (d) => d.skill !== undefined,
      }),
    );
    if (answer) onChange([...(skills ?? []), answer.skill]);
  };
  const disable = async (skill: EnvironmentSkill) => {
    const answer = await save.run(() => requestJson(`${base}/skills/${skill.id}`, { method: "DELETE" }));
    if (answer) onChange((skills ?? []).filter((s) => s.id !== skill.id));
  };

  return (
    <div className="space-y-3 p-4">
      <div className="space-y-0.5">
        <SectionHeader title="From the catalog" link={{ href: "https://skills.sh", label: "skills.sh" }} />
        <p className="text-xs text-muted-foreground">Search skills.sh and enable a skill. Up to {MAX_SKILLS}.</p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills, e.g. pdf, react, testing"
          aria-label="Search the skills catalog"
          className="pl-8"
        />
      </div>
      {searchError && <InlineMessage>{searchError}</InlineMessage>}
      {results && (
        <ul className="max-h-72 divide-y divide-border/60 overflow-auto rounded-md border border-border/60">
          {results.length === 0 && <li className="px-3 py-2 text-[13px] text-muted-foreground">No skills found.</li>}
          {results.map((r) => (
            <li key={r.slug} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{r.name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {r.source} · {r.installs.toLocaleString()} installs
                </span>
              </span>
              {enabled.has(r.slug) ? (
                <span className="text-xs text-muted-foreground">Enabled</span>
              ) : r.github ? (
                <Button size="xs" variant="outline" disabled={full || save.status === "pending"} onClick={() => void enable(r)}>
                  Enable
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground" title="Outrunner installs skills from GitHub repositories only.">
                  Not on GitHub
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {skills === null ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No catalog skills enabled.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {skills.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
              <span className="min-w-0 truncate text-foreground">{s.name}</span>
              <a
                href={`https://skills.sh/${s.slug}`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground"
              >
                {s.source}
              </a>
              <RemoveButton what={s.name} onRemove={() => void disable(s)} />
            </li>
          ))}
        </ul>
      )}
      {save.error && <InlineMessage>{save.error}</InlineMessage>}
    </div>
  );
}

/** The registries: GitHub repositories whose every skill installs. */
function Registries({
  base,
  registries,
  onChange,
}: {
  base: string;
  registries: ListedRegistry[] | null;
  onChange: (registries: ListedRegistry[]) => void;
}) {
  const [url, setUrl] = useState("");
  const save = useSave();
  const full = (registries?.length ?? 0) >= MAX_REGISTRIES;

  const add = async () => {
    const answer = await save.run(() =>
      requestJson<{ registry: SkillRegistry; skills: ListedSkill[] }>(`${base}/skill-registries`, {
        method: "POST",
        body: { url: url.trim() },
        has: (d) => d.registry !== undefined,
      }),
    );
    if (!answer) return;
    onChange([...(registries ?? []), { ...answer.registry, skills: answer.skills, error: null }]);
    setUrl("");
  };
  const remove = async (registry: ListedRegistry) => {
    const answer = await save.run(() => requestJson(`${base}/skill-registries/${registry.id}`, { method: "DELETE" }));
    if (answer) onChange((registries ?? []).filter((r) => r.id !== registry.id));
  };

  return (
    <div className="space-y-3 p-4">
      <div className="space-y-0.5">
        <SectionHeader title="Registries" />
        <p className="text-xs text-muted-foreground">
          GitHub repositories of skills: every skill in one is installed, as its default branch has it when the session starts.
          A private one needs the org&apos;s GitHub App installed with access to it. Up to{" "}
          {MAX_REGISTRIES}.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="owner/repo or https://github.com/owner/repo"
          aria-label="Registry repository"
          className="font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) void add();
          }}
        />
        <LoadingButton status={save.status} disabled={!url.trim() || full} labels={{ idle: "Add" }} onClick={() => void add()} />
      </div>
      {save.error && <InlineMessage>{save.error}</InlineMessage>}
      {registries === null ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : registries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No registries.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {registries.map((r) => (
            <li key={r.id} className="space-y-1.5 px-3 py-2 text-[13px]">
              <div className="flex items-center gap-2.5">
                <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                <a
                  href={`https://github.com/${r.fullName}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-foreground hover:underline"
                >
                  {r.fullName}
                </a>
                <span className="font-mono text-xs text-muted-foreground">{r.defaultBranch}</span>
                {r.private && <span className="text-xs text-muted-foreground">private</span>}
                <RemoveButton what={r.fullName} onRemove={() => void remove(r)} />
              </div>
              {r.error ? (
                <InlineMessage tone="warning">{r.error}</InlineMessage>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {r.skills.length === 0 ? "No skills found in it." : r.skills.map((s) => s.name).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the project's repositories commit: listed, never installed. */
function RepositorySkills({ base }: { base: string }) {
  const [items, setItems] = useState<RepoItem[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    requestJson<{ items: RepoItem[]; errors: string[] }>(`${base}/repo-skills`, {
      has: (d) => Array.isArray(d.items),
      fallback: "Couldn't read the repositories' skills.",
    })
      .then((d) => {
        if (!live) return;
        setItems(d.items);
        setErrors(d.errors ?? []);
      })
      .catch((e: Error) => {
        if (!live) return;
        setItems([]);
        setErrors([e.message]);
      });
    return () => {
      live = false;
    };
  }, [base]);

  return (
    <Panel>
      <div className="space-y-3 p-4">
        <div className="space-y-0.5">
          <SectionHeader title="In the repositories" />
          <p className="text-xs text-muted-foreground">
            Skills, subagents and commands committed in .claude or .agents. Sessions get them with the checkout; change them in
            the repository.
          </p>
        </div>
        {errors.map((e) => (
          <InlineMessage key={e} tone="warning">
            {e}
          </InlineMessage>
        ))}
        {items === null ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">None committed.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {items.map((item) => (
              <li key={`${item.fullName}:${item.path}`} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
                <span className="w-16 shrink-0 text-xs text-muted-foreground">{item.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{item.name}</span>
                  {item.description && <span className="block truncate text-xs text-muted-foreground">{item.description}</span>}
                </span>
                <a
                  href={item.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                >
                  {item.fullName} <ExternalLink className="size-3" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** Remove a skill or registry: nothing is lost, it can be added again. */
function RemoveButton({ what, onRemove }: { what: string; onRemove: () => void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="ml-auto shrink-0 text-muted-foreground"
      aria-label={`Remove ${what}`}
      title={`Remove ${what}`}
      onClick={onRemove}
    >
      <X />
    </Button>
  );
}
