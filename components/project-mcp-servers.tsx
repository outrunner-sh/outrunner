"use client";

import { Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";

import { DeleteButton, Panel, SectionTitle, useSave } from "@/components/project-section";
import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { SELECT_OPTIONS } from "@/components/ui/select-options";
import { Textarea } from "@/components/ui/textarea";
import type { Environment } from "@/lib/db/environments";
import type { EnvironmentMcpServer } from "@/lib/db/environment-mcp";
import { MAX_MCP_SERVERS, type McpServerEdit, type McpTransport, parseArgLines, parseHeaderLines, RESERVED_MCP_PREFIX } from "@/lib/environments/mcp";
import { parseDotenv } from "@/lib/environments/rules";
import { requestJson } from "@/lib/http/request-json";
import { cn } from "@/lib/utils";

/** The values a server is given, pasted: variables as a .env, headers as
 *  a request shows them. */
function parseValues(transport: McpTransport, text: string): { values: Record<string, string>; skipped: string[] } {
  if (transport === "stdio") {
    const { env, skipped } = parseDotenv(text);
    return { values: env, skipped };
  }
  const { headers, skipped } = parseHeaderLines(text);
  return { values: headers, skipped };
}

const VALUES_PLACEHOLDER: Record<McpTransport, string> = {
  stdio: "Variables, one KEY=VALUE a line\nAPI_TOKEN=...",
  http: "Headers, one Name: value a line\nAuthorization: Bearer ...",
};

/** A masked textarea for secrets, as the variables section has. */
const SECRET_TEXT = "min-h-20 font-mono text-xs [-webkit-text-security:disc] focus:[-webkit-text-security:none]";

/**
 * A project's MCP servers: every new session of it loads them, in Claude
 * Code and Codex, beside the user's own, whose win on a name both have. A
 * server is a command (stdio) or a URL (http). Its variables' and headers'
 * values are write-only, as the project's variables are: the page knows
 * their names, and a change sets or removes values by name.
 */
export function McpServersSection({ environment }: { environment: Environment }) {
  const [servers, setServers] = useState<EnvironmentMcpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const base = `/api/environments/${environment.id}/mcp-servers`;

  useEffect(() => {
    let live = true;
    requestJson<{ servers: EnvironmentMcpServer[] }>(base, {
      has: (d) => Array.isArray(d.servers),
      fallback: "Couldn't load the MCP servers.",
    })
      .then((d) => live && setServers(d.servers))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [base]);

  const replace = (server: EnvironmentMcpServer) =>
    setServers((list) => (list ?? []).map((s) => (s.id === server.id ? server : s)).sort((a, b) => a.name.localeCompare(b.name)));

  return (
    <section className="space-y-5">
      <SectionTitle
        title="MCP servers"
        detail="Loaded in every new session of the project, in Claude Code and Codex, beside your own MCP servers: yours win on a name both have. Values are encrypted and can't be read back once saved."
      />
      {loadError && <InlineMessage>{loadError}</InlineMessage>}
      <Panel>
        <NewServer
          base={base}
          full={(servers?.length ?? 0) >= MAX_MCP_SERVERS}
          onAdded={(server) => setServers((list) => [...(list ?? []), server].sort((a, b) => a.name.localeCompare(b.name)))}
        />
        {servers === null ? (
          <p className="p-4 text-[13px] text-muted-foreground">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No MCP servers yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                base={base}
                server={server}
                onSaved={replace}
                onDeleted={() => setServers((list) => (list ?? []).filter((s) => s.id !== server.id))}
              />
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

function TransportPicker({ value, onChange }: { value: McpTransport; onChange: (t: McpTransport) => void }) {
  return (
    <select
      aria-label="Transport"
      value={value}
      onChange={(e) => onChange(e.target.value as McpTransport)}
      className={cn("h-8 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground", SELECT_OPTIONS)}
    >
      <option value="stdio">stdio: a command</option>
      <option value="http">http: a URL</option>
    </select>
  );
}

function NewServer({ base, full, onAdded }: { base: string; full: boolean; onAdded: (s: EnvironmentMcpServer) => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [values, setValues] = useState("");
  const save = useSave();
  const parsed = parseValues(transport, values);
  const ready = name.trim() !== "" && (transport === "stdio" ? command.trim() !== "" : url.trim() !== "");

  const add = async () => {
    const body =
      transport === "stdio"
        ? { name: name.trim(), transport, command: command.trim(), args: parseArgLines(args), env: parsed.values }
        : { name: name.trim(), transport, url: url.trim(), headers: parsed.values };
    const answer = await save.run(() =>
      requestJson<{ server: EnvironmentMcpServer }>(base, { method: "POST", body, has: (d) => d.server !== undefined }),
    );
    if (!answer) return;
    onAdded(answer.server);
    setName("");
    setCommand("");
    setArgs("");
    setUrl("");
    setValues("");
  };

  return (
    <div className="space-y-3 p-4">
      <div className="space-y-0.5">
        <SectionHeader title="Add a server" />
        <p className="text-xs text-muted-foreground">
          Up to {MAX_MCP_SERVERS}. Names starting with &ldquo;{RESERVED_MCP_PREFIX}&rdquo; are kept for Outrunner&apos;s own.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. linear" aria-label="Server name" maxLength={64} />
        <TransportPicker value={transport} onChange={setTransport} />
      </div>
      {transport === "stdio" ? (
        <>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Command, e.g. npx"
            aria-label="Command"
            className="font-mono text-xs"
          />
          <Textarea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={"Arguments, one a line\n-y\n@acme/mcp-server"}
            aria-label="Arguments"
            spellCheck={false}
            className="min-h-16 font-mono text-xs"
          />
        </>
      ) : (
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          aria-label="URL"
          className="font-mono text-xs"
        />
      )}
      <Textarea
        value={values}
        onChange={(e) => setValues(e.target.value)}
        placeholder={VALUES_PLACEHOLDER[transport]}
        aria-label={transport === "stdio" ? "Variables" : "Headers"}
        spellCheck={false}
        autoComplete="off"
        className={SECRET_TEXT}
      />
      {parsed.skipped.length > 0 && (
        <InlineMessage tone="warning">
          {parsed.skipped.length === 1 ? "1 line isn't" : `${parsed.skipped.length} lines aren't`} a{" "}
          {transport === "stdio" ? "variable" : "header"} and will be left out.
        </InlineMessage>
      )}
      <div className="flex items-center justify-end gap-3">
        {save.error && <InlineMessage>{save.error}</InlineMessage>}
        <LoadingButton status={save.status} disabled={!ready || full} labels={{ idle: "Add server", success: "Added" }} onClick={() => void add()} />
      </div>
    </div>
  );
}

function ServerRow({
  base,
  server,
  onSaved,
  onDeleted,
}: {
  base: string;
  server: EnvironmentMcpServer;
  onSaved: (s: EnvironmentMcpServer) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const save = useSave();
  const names = server.transport === "stdio" ? server.envNames : server.headerNames;

  const send = async (edit: McpServerEdit) => {
    const answer = await save.run(() =>
      requestJson<{ server: EnvironmentMcpServer }>(`${base}/${server.id}`, { method: "PATCH", body: edit, has: (d) => d.server !== undefined }),
    );
    if (answer) onSaved(answer.server);
    return answer;
  };
  const remove = async () => {
    const answer = await save.run(() => requestJson(`${base}/${server.id}`, { method: "DELETE" }));
    if (answer) onDeleted();
  };

  return (
    <li className="space-y-2 px-4 py-3 text-[13px]">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-xs text-foreground">{server.name}</span>
        <span className="rounded border border-border/60 px-1.5 text-[11px] text-muted-foreground">{server.transport}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={`Edit ${server.name}`}
          title={`Edit ${server.name}`}
          onClick={() => setEditing((v) => !v)}
        >
          <Pencil />
        </Button>
        <DeleteButton what={server.name} onDelete={() => void remove()} />
      </div>
      {names.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => (
            <span key={n} className="flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {n} <span aria-hidden>••••</span>
              {editing && (
                <button
                  type="button"
                  aria-label={`Remove ${n}`}
                  title={`Remove ${n}`}
                  className="hover:text-foreground"
                  onClick={() => void send(server.transport === "stdio" ? { removeEnv: [n] } : { removeHeaders: [n] })}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {editing && <EditServer server={server} status={save.status} onSend={send} onDone={() => setEditing(false)} />}
      {save.error && <InlineMessage>{save.error}</InlineMessage>}
    </li>
  );
}

/** Change a server's command or URL, and set values by name. Mounted while
 *  open, so it starts from the server as it is. */
function EditServer({
  server,
  status,
  onSend,
  onDone,
}: {
  server: EnvironmentMcpServer;
  status: ReturnType<typeof useSave>["status"];
  onSend: (edit: McpServerEdit) => Promise<unknown>;
  onDone: () => void;
}) {
  const [command, setCommand] = useState(server.command ?? "");
  const [args, setArgs] = useState(server.args.join("\n"));
  const [url, setUrl] = useState(server.url ?? "");
  const [values, setValues] = useState("");
  const parsed = parseValues(server.transport, values);

  const edit: McpServerEdit =
    server.transport === "stdio"
      ? {
          ...(command.trim() !== server.command && { command: command.trim() }),
          ...(args !== server.args.join("\n") && { args: parseArgLines(args) }),
          ...(Object.keys(parsed.values).length > 0 && { setEnv: parsed.values }),
        }
      : {
          ...(url.trim() !== server.url && { url: url.trim() }),
          ...(Object.keys(parsed.values).length > 0 && { setHeaders: parsed.values }),
        };

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      {server.transport === "stdio" ? (
        <>
          <Input value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Command" className="font-mono text-xs" />
          <Textarea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="Arguments, one a line"
            aria-label="Arguments"
            spellCheck={false}
            className="min-h-16 font-mono text-xs"
          />
        </>
      ) : (
        <Input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" className="font-mono text-xs" />
      )}
      <Textarea
        value={values}
        onChange={(e) => setValues(e.target.value)}
        placeholder={`Add or replace ${server.transport === "stdio" ? "variables" : "headers"}\n${VALUES_PLACEHOLDER[server.transport].split("\n")[1]}`}
        aria-label={server.transport === "stdio" ? "Variables to set" : "Headers to set"}
        spellCheck={false}
        autoComplete="off"
        className={SECRET_TEXT}
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
        <LoadingButton
          status={status}
          disabled={Object.keys(edit).length === 0}
          labels={{ idle: "Save", success: "Saved" }}
          onClick={async () => {
            if (await onSend(edit)) setValues("");
          }}
        />
      </div>
    </div>
  );
}
