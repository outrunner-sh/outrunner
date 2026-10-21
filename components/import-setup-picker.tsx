"use client";

import { Badge } from "@/components/ui/badge";
import type { ConfigPick, EnvironmentPick } from "@/lib/imports/client";
import { skipText } from "@/lib/imports/client";
import type { ScannedAgentConfig, ScannedProjectEnv } from "@/lib/runtime/import-scan";

/** Whether anything picked carries secrets, so the user must agree first. */
export function picksSecrets(envs: EnvironmentPick[], config: ConfigPick): boolean {
  return envs.some((e) => e.vars.length > 0 || e.files.length > 0) || config.mcp.length > 0;
}

export function emptyEnvPick(repo: string): EnvironmentPick {
  return { repo, vars: [], files: [], scripts: false };
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Check({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/**
 * Each repository's environment on the Mac — Conductor's variables, the .env
 * files its checkout keeps out of git, Conductor's scripts — offered by name.
 */
export function EnvironmentPicker({
  projects,
  picks,
  onChange,
  disabled,
}: {
  projects: ScannedProjectEnv[];
  picks: Record<string, EnvironmentPick>;
  onChange: (pick: EnvironmentPick) => void;
  disabled: boolean;
}) {
  if (projects.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Project environments</h2>
      <p className="text-xs text-muted-foreground">
        Variables and files your cloud sessions start with. Kept encrypted, per project.
      </p>
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {projects.map((p) => {
          const pick = picks[p.repo] ?? emptyEnvPick(p.repo);
          return (
            <li key={p.repo} className="space-y-2 p-3">
              <div className="text-sm font-medium">{p.repo}</div>
              {p.vars.map((v) => (
                <Check
                  key={`var:${v.name}`}
                  checked={pick.vars.includes(v.name)}
                  onChange={() => onChange({ ...pick, vars: toggled(pick.vars, v.name) })}
                  disabled={disabled}
                >
                  <code className="text-xs">{v.name}</code>{" "}
                  <span className="text-xs text-muted-foreground">
                    Conductor variable{v.shared ? ", set for every repository" : ""}
                  </span>
                </Check>
              ))}
              {p.files.map((f) => (
                <Check
                  key={`file:${f.path}`}
                  checked={pick.files.includes(f.path)}
                  onChange={() => onChange({ ...pick, files: toggled(pick.files, f.path) })}
                  disabled={disabled}
                >
                  <code className="text-xs">{f.path}</code>{" "}
                  <span className="text-xs text-muted-foreground">
                    {f.names.length > 0 ? f.names.join(", ") : "sets nothing readable"}
                  </span>
                </Check>
              ))}
              {p.scripts && (
                <Check
                  checked={pick.scripts}
                  onChange={() => onChange({ ...pick, scripts: !pick.scripts })}
                  disabled={disabled}
                >
                  Conductor&apos;s scripts{" "}
                  <span className="text-xs text-muted-foreground">
                    (the setup script runs as each cloud session starts)
                  </span>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                    {[
                      p.scripts.setup && `# setup\n${p.scripts.setup}`,
                      p.scripts.run && `# run\n${p.scripts.run}`,
                      p.scripts.archive && `# archive\n${p.scripts.archive}`,
                    ]
                      .filter(Boolean)
                      .join("\n\n")}
                  </pre>
                </Check>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const KIND_LABEL: Record<ScannedAgentConfig["items"][number]["kind"], string> = {
  "claude-md": "Claude instructions",
  skill: "Skill",
  agent: "Subagent",
  command: "Command",
  "agents-md": "Codex instructions",
};

/** The user's own agent setup on the Mac, offered by name. */
export function AgentSetupPicker({
  config,
  pick,
  onChange,
  disabled,
}: {
  config: ScannedAgentConfig;
  pick: ConfigPick;
  onChange: (pick: ConfigPick) => void;
  disabled: boolean;
}) {
  const takable = config.items.filter((i) => !i.skip).map((i) => i.id);
  if (config.items.length === 0 && config.mcpServers.length === 0 && config.plugins.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Your agent setup</h2>
        {takable.length > 0 && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => onChange({ ...pick, items: pick.items.length === takable.length ? [] : takable })}
            disabled={disabled}
          >
            {pick.items.length === takable.length ? "Clear files" : "Pick every file"}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Installed on your cloud computers for every session. Importing again replaces what you imported before.
      </p>
      <div className="max-h-72 space-y-1 overflow-auto rounded-md border border-border/60 p-3">
        {config.items.map((item) => (
          <Check
            key={item.id}
            checked={pick.items.includes(item.id)}
            onChange={() => onChange({ ...pick, items: toggled(pick.items, item.id) })}
            disabled={disabled || item.skip !== undefined}
          >
            {item.name} <Badge variant="outline">{KIND_LABEL[item.kind]}</Badge>
            {item.skip && <span className="text-xs text-muted-foreground"> · {skipText(item.skip)}</span>}
            {item.omitted ? (
              <span className="text-xs text-muted-foreground"> · {item.omitted} linked files left out</span>
            ) : null}
          </Check>
        ))}
        {config.mcpServers.map((server) => (
          <Check
            key={`mcp:${server.name}`}
            checked={pick.mcp.includes(server.name)}
            onChange={() => onChange({ ...pick, mcp: toggled(pick.mcp, server.name) })}
            disabled={disabled || server.skip !== undefined}
          >
            {server.name} <Badge variant="outline">MCP server</Badge>
            <span className="text-xs text-muted-foreground">
              {" "}
              · {server.url ?? server.command}
              {server.headerNames.length + server.envNames.length > 0 &&
                ` · with ${[...server.headerNames, ...server.envNames].join(", ")}`}
              {server.skip && ` · ${skipText(server.skip)}`}
            </span>
          </Check>
        ))}
        {config.plugins.length > 0 && (
          <Check checked={pick.plugins} onChange={() => onChange({ ...pick, plugins: !pick.plugins })} disabled={disabled}>
            Plugins <Badge variant="outline">{config.plugins.join(", ")}</Badge>
          </Check>
        )}
      </div>
    </section>
  );
}
