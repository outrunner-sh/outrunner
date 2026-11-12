"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import { SELECT_OPTIONS } from "@/components/ui/select-options";
import { requestJson } from "@/lib/http/request-json";
import type { SettingsRule, SettingsScope, SettingsTracker } from "@/lib/trackers/org-settings";
import { isClosedStateType, LINEAR_PRIORITIES, RULE_SESSIONS_MAX, type RuleFilters, type StateMap, type TrackerProvider, UNASSIGNED } from "@/lib/trackers/rules";
import { cn } from "@/lib/utils";

type Project = { id: string; fullName: string };
type Team = { id: string; key: string; name: string };
/** What a team's rules pick from. Jira names its own priorities, and has issue types. */
type Catalog = {
  states: { id: string; name: string; type: string }[];
  labels: { id: string; name: string }[];
  members: { id: string; name: string }[];
  priorities?: { id: string; name: string }[];
  issueTypes?: { id: string; name: string }[];
};

/** The words that differ between trackers: Linear's teams are Jira's projects. */
const WORDS = {
  linear: { name: "Linear", site: "workspace", team: "team", Team: "Team", teams: "teams", docs: "docs/linear-app.md", install: "/api/integrations/linear/install", ruleLead: "A Linear rule that delegates to Outrunner", beforeInstall: null },
  jira: { name: "Jira", site: "site", team: "project", Team: "Project", teams: "projects", docs: "docs/jira-app.md", install: "/api/integrations/jira/install", ruleLead: "A Jira Automation rule that assigns an issue to Outrunner", beforeInstall: "Authorize as a dedicated Outrunner account on one site, not your own. Issues assigned to or mentioning the account you authorize as start sessions, and Outrunner comments as it." },
} as const;
const Words = createContext<(typeof WORDS)[TrackerProvider]>(WORDS.linear);

const SELECT = cn("h-8 min-w-0 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground disabled:opacity-60", SELECT_OPTIONS);

/** Run a change, then show what the server now has; a refusal shows its reason. */
function useChange() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await requestJson(url, { method, body });
      router.refresh();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save that.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

const EMPTY_STATE_MAP: StateMap = { started: null, inReview: null, done: null, blocked: null };

/** The state map's four, in the order work goes through them. Only Done is a closed state:
 *  the rest are where work goes while it's open. */
const STATE_PICKS: { key: keyof StateMap; label: string; none: string; lead: string; closed: boolean }[] = [
  { key: "started", label: "State when a session starts", none: "Session started: no change", lead: "Started", closed: false },
  { key: "blocked", label: "State while it's blocked", none: "Blocked: no change", lead: "Blocked", closed: false },
  { key: "inReview", label: "State when its PR opens", none: "PR opened: no change", lead: "PR opened", closed: false },
  { key: "done", label: "State when its PR merges", none: "PR merged: no change", lead: "PR merged", closed: true },
];

/**
 * The org's Linear workspaces or Jira sites, their connected teams or projects, and each
 * one's settings and rules. Every member sees them; only an admin changes them.
 */
export function TrackerSettings({
  provider,
  orgId,
  admin,
  available,
  trackers,
  projects,
}: {
  provider: TrackerProvider;
  orgId: string;
  admin: boolean;
  /** Whether this deployment can connect the tracker at all. */
  available: boolean;
  trackers: SettingsTracker[];
  projects: Project[];
}) {
  const words = WORDS[provider];
  return (
    <Words.Provider value={words}>
      <div className="space-y-8">
        {trackers.map((tracker) => (
          <Workspace key={tracker.id} orgId={orgId} admin={admin} available={available} tracker={tracker} projects={projects} />
        ))}
        {trackers.length === 0 && <p className="text-xs text-muted-foreground">Not connected.{admin ? "" : ` Ask an admin of the org to connect ${words.name}.`}</p>}
        {admin && available && words.beforeInstall && <p className="text-xs text-muted-foreground">{words.beforeInstall}</p>}
        {admin && available && (
          <Button asChild size="sm" variant="outline">
            <a href={words.install}>{trackers.length ? `Connect another ${words.site}` : "Install"}</a>
          </Button>
        )}
        {!available && (
          <p className="text-xs text-muted-foreground">
            {words.name} isn&apos;t set up on this deployment yet: see <code className="font-mono">{words.docs}</code>.
          </p>
        )}
      </div>
    </Words.Provider>
  );
}

function Workspace({
  orgId,
  admin,
  available,
  tracker,
  projects,
}: {
  orgId: string;
  admin: boolean;
  available: boolean;
  tracker: SettingsTracker;
  projects: Project[];
}) {
  const change = useChange();
  const words = useContext(Words);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className={tracker.disconnected ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-emerald-500"} />
          <span className="font-medium text-foreground">{tracker.name ?? tracker.externalId}</span>
          {tracker.disconnected && <span className="text-xs text-muted-foreground">Disconnected: rules have stopped</span>}
        </div>
        {admin && (
          <div className="flex items-center gap-2">
            {tracker.disconnected && available && (
              <Button asChild size="sm" variant="outline">
                <a href={words.install}>Reconnect</a>
              </Button>
            )}
            <HoldToConfirm
              label="Disconnect"
              onConfirm={() => void change.run(`/api/orgs/${orgId}/trackers/${tracker.id}`, "DELETE")}
              className="h-7 px-2.5 text-xs"
            />
          </div>
        )}
      </div>
      {tracker.connectedAs && (
        <p className="text-xs text-muted-foreground">Connected as {tracker.connectedAs}. Issues assigned to or mentioning this account start sessions.</p>
      )}
      {tracker.webhookProblem && (
        <InlineMessage>{words.name}&apos;s webhook isn&apos;t active, so nothing is arriving from this {words.site}. Outrunner keeps trying to register it.</InlineMessage>
      )}
      {change.error && <InlineMessage>{change.error}</InlineMessage>}
      {tracker.scopes.map((scope) => (
        <Team key={scope.id} orgId={orgId} admin={admin} disconnected={tracker.disconnected} scope={scope} projects={projects} />
      ))}
      {tracker.scopes.length === 0 && <p className="text-xs text-muted-foreground">No {words.team} is connected yet.</p>}
      {admin && !tracker.disconnected && <ConnectTeam orgId={orgId} tracker={tracker} />}
    </div>
  );
}

function ConnectTeam({ orgId, tracker }: { orgId: string; tracker: SettingsTracker }) {
  const change = useChange();
  const words = useContext(Words);
  const couldnt = `Couldn't load ${words.name}'s ${words.teams}.`;
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  useEffect(() => {
    let live = true;
    requestJson<{ teams: Team[] }>(`/api/orgs/${orgId}/trackers/${tracker.id}/teams`, { fallback: couldnt })
      .then((answer) => live && setTeams(answer.teams))
      .catch((error: unknown) => live && setLoadError(error instanceof Error ? error.message : couldnt));
    return () => {
      live = false;
    };
  }, [orgId, tracker.id, couldnt]);
  const open = teams?.filter((team) => !tracker.scopes.some((scope) => scope.externalTeamId === team.id)) ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select aria-label={`${words.Team} to connect`} value={picked} onChange={(e) => setPicked(e.target.value)} className={cn(SELECT, "flex-1")}>
          <option value="">{teams === null ? `Loading ${words.teams}…` : open.length ? `Pick a ${words.team}` : `No other ${words.teams}`}</option>
          {open.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name} ({team.key})
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!picked || change.busy}
          onClick={() => void change.run(`/api/orgs/${orgId}/trackers/${tracker.id}/teams`, "POST", { teamId: picked }).then((ok) => ok && setPicked(""))}
        >
          Connect {words.team}
        </Button>
      </div>
      {(loadError ?? change.error) && <InlineMessage>{loadError ?? change.error}</InlineMessage>}
    </div>
  );
}

function Team({
  orgId,
  admin,
  disconnected,
  scope,
  projects,
}: {
  orgId: string;
  admin: boolean;
  disconnected: boolean;
  scope: SettingsScope;
  projects: Project[];
}) {
  const change = useChange();
  const words = useContext(Words);
  const couldnt = `Couldn't load this ${words.team} from ${words.name}.`;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const url = `/api/orgs/${orgId}/trackers/scopes/${scope.id}`;
  useEffect(() => {
    // A disconnected install has no token to ask with: there's no answer to wait for.
    if (disconnected) return;
    let live = true;
    requestJson<{ catalog: Catalog }>(url, { fallback: couldnt })
      .then((answer) => live && setCatalog(answer.catalog))
      .catch((error: unknown) => live && setCatalogError(error instanceof Error ? error.message : couldnt));
    return () => {
      live = false;
    };
  }, [url, disconnected, couldnt]);
  // What rules can pick from isn't known, and won't be: don't offer to pick.
  const unavailable = disconnected || catalogError !== null;
  const patch = (body: Record<string, unknown>) => void change.run(url, "PATCH", body);
  // Where work moves to: a closed state isn't somewhere work is under way.
  const states = (catalog?.states ?? []).filter((state) => !isClosedStateType(state.type));
  // Done is where merged work goes: one of the team's done states, never canceled or a duplicate.
  const doneStates = (catalog?.states ?? []).filter((state) => state.type === "completed");

  return (
    <div className="@container space-y-5 rounded-md border border-border/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{scope.name ?? scope.externalTeamId}</h2>
        {admin && <HoldToConfirm label={`Disconnect ${words.team}`} onConfirm={() => void change.run(url, "DELETE")} className="h-7 px-2.5 text-xs" />}
      </div>
      {catalogError && <InlineMessage>{catalogError} Rules still run, but can&apos;t be added or edited until it loads.</InlineMessage>}
      {change.error && <InlineMessage>{change.error}</InlineMessage>}
      {disconnected && <p className="text-xs text-muted-foreground">Reconnect to see this {words.team}&apos;s labels, statuses and people.</p>}

      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-medium text-foreground">Triage rules</h3>
          <p className="text-xs text-muted-foreground">The first enabled match files the issue.</p>
        </div>
        {scope.rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">No rules: nothing from this {words.team} is filed.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {scope.rules.map((rule, index) => (
              <Rule
                key={rule.id}
                orgId={orgId}
                admin={admin}
                rule={rule}
                catalog={catalog}
                unavailable={unavailable}
                projects={projects}
                first={index === 0}
                last={index === scope.rules.length - 1}
              />
            ))}
          </ul>
        )}
        {admin &&
          (adding ? (
            <RuleForm
              catalog={catalog}
              projects={projects}
              submit="Add rule"
              onCancel={() => setAdding(false)}
              onSave={async (input) => {
                const ok = await change.run(`${url}/rules`, "POST", input);
                if (ok) setAdding(false);
                return ok;
              }}
            />
          ) : (
            <Button size="sm" variant="outline" disabled={unavailable} onClick={() => setAdding(true)}>
              Add rule
            </Button>
          ))}
      </div>

      <div className="grid gap-4 @md:grid-cols-2">
        <Field label="Default repository" hint={`For issues delegated from this ${words.team}, unless they name one.`}>
          <select
            aria-label="Default repository"
            disabled={!admin || change.busy}
            value={scope.defaultProjectId ?? ""}
            onChange={(e) => patch({ defaultProjectId: e.target.value || null })}
            className={SELECT}
          >
            <option value="">None: ask when delegated</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.fullName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Issue state for delegated work" hint="Moved when its session starts or picks up again, while it's blocked, when its PR opens, and when it merges.">
          <div className="flex flex-wrap gap-2">
            {STATE_PICKS.map((pick) => (
              <select
                key={pick.key}
                aria-label={pick.label}
                disabled={!admin || change.busy || unavailable}
                value={scope.stateMap?.[pick.key] ?? ""}
                onChange={(e) => patch({ stateMap: { ...EMPTY_STATE_MAP, ...scope.stateMap, [pick.key]: e.target.value || null } })}
                className={SELECT}
              >
                <option value="">{pick.none}</option>
                <StateNotOffered id={scope.stateMap?.[pick.key]} lead={pick.lead} states={pick.closed ? doneStates : states} catalog={catalog} />
                {(pick.closed ? doneStates : states).map((state) => (
                  <option key={state.id} value={state.id}>
                    {pick.lead}: {state.name}
                  </option>
                ))}
              </select>
            ))}
          </div>
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-1"
            disabled={!admin || change.busy}
            checked={scope.acceptRuleSessions}
            onChange={(e) => patch({ acceptRuleSessions: e.target.checked })}
          />
          <span>
            Accept sessions started by {words.name} rules
            <span className="block text-xs text-muted-foreground">
              {words.ruleLead} starts a session as the issue&apos;s creator, on their Outrunner
              allowance. Off, it gets a reply and nothing starts.
            </span>
          </span>
        </label>
        <Cap key={scope.ruleSessionsPerDay} admin={admin} busy={change.busy} value={scope.ruleSessionsPerDay} onSave={(cap) => patch({ ruleSessionsPerDay: cap })} />
      </div>
    </div>
  );
}

/** The state stored is what runs, so a select never reads as "no change" for one it can't
 *  name: while the catalog is loading, or for one gone from the tracker. */
function StateNotOffered({ id, lead, states, catalog }: { id: string | null | undefined; lead: string; states: { id: string }[]; catalog: Catalog | null }) {
  if (!id || states.some((state) => state.id === id)) return null;
  return <option value={id}>{lead}: {catalog ? "a state that's gone" : "not loaded yet"}</option>;
}

function Cap({ admin, busy, value, onSave }: { admin: boolean; busy: boolean; value: number; onSave: (cap: number) => void }) {
  const [text, setText] = useState(String(value));
  const save = () => {
    const cap = Number(text);
    if (Number.isInteger(cap) && cap >= 1 && cap <= RULE_SESSIONS_MAX && cap !== value) onSave(cap);
    else setText(String(value));
  };
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      At most
      <Input
        aria-label="Most rule-started sessions a day"
        inputMode="numeric"
        className="h-7 w-16 text-xs"
        disabled={!admin || busy}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
      />
      rule-started sessions a day (UTC). Past it, the rule gets a reply and nothing starts.
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** What a rule's filters pick from, each with the tracker's id and its name. */
function filterOptions(catalog: Catalog | null, jira: boolean) {
  return {
    labels: catalog?.labels.map((l) => ({ id: l.id, label: l.name })) ?? [],
    // A closed issue is never filed, so a rule on a closed state would never match.
    states: catalog?.states.filter((s) => !isClosedStateType(s.type)).map((s) => ({ id: s.id, label: s.name })) ?? [],
    priorities: jira ? (catalog?.priorities?.map((p) => ({ id: p.id, label: p.name })) ?? []) : [...LINEAR_PRIORITIES],
    issueTypes: catalog?.issueTypes?.map((t) => ({ id: t.id, label: t.name })) ?? [],
    assignees: [{ id: UNASSIGNED, label: "Unassigned" }, ...(catalog?.members.map((m) => ({ id: m.id, label: m.name })) ?? [])],
  };
}

const FILTER_LABELS = { labels: "Labels", states: "Status", priorities: "Priority", issueTypes: "Issue type", assignees: "Assignee" } as const;
type FilterField = keyof typeof FILTER_LABELS;
const FILTER_FIELDS = Object.keys(FILTER_LABELS) as FilterField[];
/** Linear has no issue types. */
const fieldsOf = (jira: boolean) => (jira ? FILTER_FIELDS : FILTER_FIELDS.filter((field) => field !== "issueTypes"));

function ruleSummary(rule: RuleFilters, catalog: Catalog | null, unavailable: boolean, jira: boolean): string {
  const options = filterOptions(catalog, jira);
  const parts = fieldsOf(jira).flatMap((field) => {
    if (rule[field].length === 0) return [];
    const known = rule[field].map((id) => options[field].find((o) => o.id === id)?.label ?? null);
    // The tracker can't be asked for the names: say how many, as a name can't be made up.
    if (unavailable && !catalog && known.includes(null)) return [`${FILTER_LABELS[field]}: ${rule[field].length} picked`];
    // A name the tracker no longer has: it was removed there, or isn't loaded yet.
    const names = known.map((name) => name ?? (catalog ? "(removed)" : "…"));
    return [`${FILTER_LABELS[field]}: ${names.join(" or ")}`];
  });
  return parts.length ? parts.join(" · ") : "Every issue";
}

function Rule({
  orgId,
  admin,
  rule,
  catalog,
  unavailable,
  projects,
  first,
  last,
}: {
  orgId: string;
  admin: boolean;
  rule: SettingsRule;
  catalog: Catalog | null;
  unavailable: boolean;
  projects: Project[];
  first: boolean;
  last: boolean;
}) {
  const change = useChange();
  const [editing, setEditing] = useState(false);
  const jira = useContext(Words).name === "Jira";
  const url = `/api/orgs/${orgId}/trackers/rules/${rule.id}`;
  const project = rule.projectId ? (projects.find((p) => p.id === rule.projectId)?.fullName ?? "a project") : "Unsorted";

  if (editing) {
    return (
      <li className="p-3">
        <RuleForm
          catalog={catalog}
          projects={projects}
          initial={rule}
          submit="Save rule"
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            const ok = await change.run(url, "PATCH", input);
            if (ok) setEditing(false);
            return ok;
          }}
        />
        {change.error && <InlineMessage>{change.error}</InlineMessage>}
      </li>
    );
  }
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0 text-sm">
          <span className={rule.enabled ? "text-foreground" : "text-muted-foreground line-through"}>{ruleSummary(rule, catalog, unavailable, jira)}</span>
          <span className="text-muted-foreground"> → {project}</span>
        </div>
        {admin && (
          <div className="flex shrink-0 items-center gap-1">
            <label className="mr-1 flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" disabled={change.busy} checked={rule.enabled} onChange={(e) => void change.run(url, "PATCH", { enabled: e.target.checked })} />
              On
            </label>
            <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={first || change.busy} onClick={() => void change.run(url, "PATCH", { move: "up" })}>
              <ArrowUp />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={last || change.busy} onClick={() => void change.run(url, "PATCH", { move: "down" })}>
              <ArrowDown />
            </Button>
            <Button size="sm" variant="ghost" disabled={unavailable} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Remove rule" disabled={change.busy} onClick={() => void change.run(url, "DELETE")}>
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      {rule.stopped && rule.enabled && (
        <p className="text-xs text-destructive">Stopped: whoever set this rule has left, or can&apos;t file there. {admin ? "Edit and save it to take it on." : "Ask an admin to take it on."}</p>
      )}
      {change.error && <InlineMessage>{change.error}</InlineMessage>}
    </li>
  );
}

function RuleForm({
  catalog,
  projects,
  initial,
  submit,
  onSave,
  onCancel,
}: {
  catalog: Catalog | null;
  projects: Project[];
  initial?: SettingsRule;
  submit: string;
  onSave: (input: RuleFilters & { projectId: string | null }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [filters, setFilters] = useState<Record<FilterField, string[]>>({
    labels: initial?.labels ?? [],
    states: initial?.states ?? [],
    priorities: initial?.priorities ?? [],
    issueTypes: initial?.issueTypes ?? [],
    assignees: initial?.assignees ?? [],
  });
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [saving, setSaving] = useState(false);
  const jira = useContext(Words).name === "Jira";
  const options = filterOptions(catalog, jira);
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <p className="text-xs text-muted-foreground">Every filter set must match; any one value within a filter will do. An empty filter matches anything.</p>
      <div className="grid gap-3 @md:grid-cols-2">
        {fieldsOf(jira).map((field) => (
          <FilterPicker
            key={field}
            label={FILTER_LABELS[field]}
            options={options[field]}
            value={filters[field]}
            onChange={(value) => setFilters((current) => ({ ...current, [field]: value }))}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Where it files" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={cn(SELECT, "flex-1")}>
          <option value="">File to Unsorted</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              File to {project.fullName}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onSave({ ...filters, projectId: projectId || null }).finally(() => setSaving(false));
          }}
        >
          {submit}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One filter's values, as a list of checkboxes. A value no longer offered (its
 *  label was removed in the tracker) stays until unticked, shown as such. */
function FilterPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const gone = value.filter((id) => !options.some((o) => o.id === id)).map((id) => ({ id, label: "(removed)" }));
  const shown = [...options, ...gone];
  return (
    <details className="rounded-md border border-input">
      <summary className="cursor-pointer px-2 py-1.5 text-[13px] text-foreground">
        {label}
        <span className="text-muted-foreground"> · {value.length ? `${value.length} picked` : "any"}</span>
      </summary>
      <div className="max-h-48 space-y-1 overflow-y-auto border-t border-border/60 px-2 py-1.5">
        {shown.length === 0 && <p className="text-xs text-muted-foreground">Nothing to pick yet.</p>}
        {shown.map((option) => (
          <label key={option.id} className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={value.includes(option.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, option.id] : value.filter((id) => id !== option.id))}
            />
            {option.label}
          </label>
        ))}
      </div>
    </details>
  );
}
