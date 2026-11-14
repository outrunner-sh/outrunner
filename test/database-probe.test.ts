import assert from "node:assert/strict";
import { test } from "node:test";

import { probeRuntimeDatabase, probeStatus, RUNTIME_COLUMNS, type ProbeClient } from "@/lib/supabase/probe";

test("probe errors read as missing tables, outdated tables, or an unreachable database", () => {
  assert.equal(probeStatus(null), "ok");
  assert.equal(probeStatus({ code: "PGRST205" }), "missing");
  assert.equal(probeStatus({ code: "42P01" }), "missing");
  assert.equal(probeStatus({ code: "42703" }), "outdated");
  assert.equal(probeStatus({ code: "PGRST204" }), "outdated");
  assert.equal(probeStatus({ code: "08006" }), "unreachable");
  assert.equal(probeStatus({}), "unreachable");
});

test("the workspaces probe asks for the title column, which a later migration added", () => {
  assert.ok(RUNTIME_COLUMNS.workspaces.includes("title"));
});

/** A database whose tables have exactly these columns. */
function fakeDatabase(schema: Record<string, string[]>): { client: ProbeClient; asked: Record<string, string> } {
  const asked: Record<string, string> = {};
  const client: ProbeClient = {
    from(table) {
      return {
        select(columns) {
          asked[table] = columns;
          return {
            limit: async () => {
              if (!schema[table]) return { error: { code: "PGRST205" } };
              const absent = columns.split(",").some((c) => !schema[table].includes(c));
              return { error: absent ? { code: "42703" } : null };
            },
          };
        },
      };
    },
  };
  return { client, asked };
}

const complete = Object.fromEntries(
  Object.entries(RUNTIME_COLUMNS).map(([table, columns]) => [table, [...columns]]),
);

test("a fully migrated database probes ok, asking each table for its columns", async () => {
  const { client, asked } = fakeDatabase(complete);
  assert.deepEqual(await probeRuntimeDatabase(client), {
    projects: "ok",
    workspaces: "ok",
    pull_requests: "ok",
  });
  assert.equal(asked.workspaces, RUNTIME_COLUMNS.workspaces.join(","));
});

test("a database without workspaces.title is outdated, not migrated", async () => {
  const { client } = fakeDatabase({
    ...complete,
    workspaces: complete.workspaces.filter((c) => c !== "title"),
  });
  const probe = await probeRuntimeDatabase(client);
  assert.equal(probe.workspaces, "outdated");
  assert.equal(probe.projects, "ok");
});

test("a missing table is reported missing", async () => {
  const { pull_requests: _omitted, ...rest } = complete;
  void _omitted;
  const { client } = fakeDatabase(rest);
  assert.equal((await probeRuntimeDatabase(client)).pull_requests, "missing");
});

test("a probe that throws leaves that table unreachable", async () => {
  const client: ProbeClient = {
    from: () => ({ select: () => ({ limit: () => Promise.reject(new Error("socket hang up")) }) }),
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await probeRuntimeDatabase(client)).workspaces, "unreachable");
  } finally {
    console.error = original;
  }
});

test("the chat-name migration is required before the database probes ready", async () => {
  assert.ok(RUNTIME_COLUMNS.workspaces.includes("main_chat_name"));
  const { client } = fakeDatabase({ ...complete, workspaces: complete.workspaces.filter((column) => column !== "main_chat_name") });
  assert.equal((await probeRuntimeDatabase(client)).workspaces, "outdated");
});
