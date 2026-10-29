import { execFileSync } from "node:child_process";
import { unixFetch } from "./unix-fetch.mjs";
/** Dedicated operator-only live check. No OAuth credential is printed. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveAgentAuth } from "@/lib/agents/resolve";
import { agentAuthStore } from "@/lib/db/credentials";
import { codexStore, codexAccounts } from "@/lib/codex/store";
import { CodexError, renewCodex } from "@/lib/codex/account";
import { inferenceGrant, authorizeGrant, readGrant } from "@/lib/codex/grant";
import { AgentClient } from "@/lib/runtime/agent-client";

import { root, systemEnv } from "./env.mjs";
assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:55421");
assert.equal(process.env.RUNTIME_BASE_URL, "http://127.0.0.1:3408");
const state = JSON.parse(readFileSync(root + "/state.json", "utf8"));
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const agents = ["computer-a", "computer-b"].map(
  (name, i) =>
    new AgentClient(
      {
        controlBaseUrl: "http://codex-live-agent",
        controlHeaders: {},
        wsBaseUrl: "ws://codex-live-agent",
        secret:
          i === 0
            ? process.env.RUNTIME_AGENT_SECRET
            : process.env.RUNTIME_AGENT_MEMBER_SECRET,
      },
      unixFetch(root + "/" + name + "/agent.sock"),
    ),
);
const agentFor = (id) =>
  agents[ids.findIndex((x) => x.workspaceId === id.workspaceId)];
const ids = [state.owner, state.member].map((u, i) => ({
  workspaceId: "codex-live-328-" + i,
  projectId: "codex-live-328",
  computerId: "codex-live-328-computer-" + i,
  userId: u.id,
}));
const check = ({ data, error }) => {
  assert.equal(error, null, "isolated database operation");
  return data;
};
const pass = (message) => console.log("PASS " + message);
async function cleanup() {
  for (const identity of ids)
    await agentFor(identity)
      .destroyWorkspace(identity)
      .catch(() => {});
}
if (process.argv.includes("--cleanup")) {
  if (
    process.argv.includes("--check-revoked") &&
    existsSync(root + "/last-grants.json")
  ) {
    for (const grant of JSON.parse(
      readFileSync(root + "/last-grants.json", "utf8"),
    )) {
      const response = await fetch(
        grant.url + "/models?client_version=0.146.0",
        { headers: { Authorization: "Bearer " + grant.bearer } },
      );
      assert.equal(
        response.status,
        403,
        "Disconnected connection must reject old grants",
      );
    }
    unlinkSync(root + "/last-grants.json");
    pass("Disconnected connection rejects all retained runtime grants");
  }
  await cleanup();
  console.log("PASS isolated runtime sessions cleared");
  process.exit(0);
}
// This inspects only our own fresh containers' key names and isolation.
const isolation = execFileSync(
  "node",
  [root + "/app/scripts/codex-live/isolation.mjs"],
  { env: systemEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
process.stdout.write(isolation);
if (process.argv.includes("--preflight")) {
  try {
    for (let i = 0; i < ids.length; i++) {
      const health = await agents[i].health(ids[i]);
      assert.ok(health.features?.includes("codex-account"));
      const folder = "/data/test-repo";
      await agents[i].createWorkspace(
        {
          workspaceId: ids[i].workspaceId,
          repoFullName: "isolated/test",
          repoPath: folder,
          branch: "preflight-" + i + "-" + Date.now(),
          baseBranch: "main",
          agent: "codex",
          permissionMode: "default",
        },
        ids[i],
      );
      await agents[i].setModel(ids[i], { model: "gpt-6.1-sol" });
    }
    pass(
      "Both isolated runtime HTTP transports, capabilities and session/model setup",
    );
    const { data, error } = await db
      .from("codex_connections")
      .select("status")
      .eq("key", "org:" + state.org)
      .maybeSingle();
    assert.equal(error, null);
    assert.ok(!data || data.status === "disconnected");
    pass(
      "Actual migrated controller DB reachable; no provider connection fabricated",
    );
  } finally {
    await cleanup();
  }
  process.exit(0);
}
let stage = "read connected organization";
try {
  const key = "org:" + state.org;
  const row = await codexStore.read(key);
  assert.equal(
    row?.status,
    "connected",
    "Complete browser approval before running live checks",
  );
  assert.ok(row?.ciphertext?.startsWith("v1."));
  const resume = process.argv.includes("--resume-after-inference");
  if (resume) {
    const previous = JSON.parse(readFileSync(root + "/auto-verification.json", "utf8"));
    for (const actor of ["admin", "teammate (no teammate provider login)"])
      assert.ok(previous.checks.includes("PASS Native runtime/TUI inference through real broker as " + actor));
    const oldGrants = JSON.parse(readFileSync(root + "/last-grants.json", "utf8"));
    assert.equal(oldGrants.length, 2);
    for (const grant of oldGrants)
      assert.equal(readGrant(grant.bearer).generation, row.generation,
        "Reuse inference evidence only for the same approved connection");
    pass("Reused successful admin/teammate native inference for this same connection");
  }
  pass("Connection saved encrypted in migrated isolated DB");
  const auths = await Promise.all(
    [state.owner, state.member].map((u) =>
      resolveAgentAuth(agentAuthStore(u.id, state.org), "codex", "cloud"),
    ),
  );
  assert.ok(auths.every((a) => a.credential?.kind === "codex-account"));
  pass("Real resolver selects org connection for admin and current teammate");
  const packed = auths.map((a) => a.credential.token);
  const grants = packed.map((p) =>
    JSON.parse(Buffer.from(p, "base64url").toString()),
  );
  writeFileSync(root + "/last-grants.json", JSON.stringify(grants), {
    mode: 0o600,
  });
  const request = async (g, path = "models?client_version=0.146.0") =>
    fetch(g.url + "/" + path, {
      headers: { Authorization: "Bearer " + g.bearer },
      signal: AbortSignal.timeout(30000),
    });
  stage = "live provider model catalog";
  const catalogResponse = await request(grants[0]);
  assert.equal(
    catalogResponse.status,
    200,
    "GET real broker models HTTP " + catalogResponse.status,
  );
  const catalog = await catalogResponse.json();
  const slugs = (catalog.models ?? [])
    .map((m) => m.slug)
    .filter(
      (s) =>
        typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(s),
    );
  const model = slugs.includes("gpt-6.1-sol") ? "gpt-6.1-sol" : slugs[0];
  assert.ok(model, "Provider returned no usable native model");
  console.log("INFO Native catalog selected " + model);
  pass("Real controller broker accepted by provider model catalog");
  stage = "grant isolation";
  const outsider = JSON.parse(
    Buffer.from(
      inferenceGrant(state.outsider.id, state.org, row),
      "base64url",
    ).toString(),
  );
  assert.equal((await request(outsider)).status, 403);
  const wrongOrg = JSON.parse(
    Buffer.from(
      inferenceGrant(state.owner.id, state.otherOrg, row),
      "base64url",
    ).toString(),
  );
  assert.equal((await request(wrongOrg)).status, 403);
  pass(
    "Nonmember and cross-organization grants rejected before upstream (admin belongs to both orgs)",
  );
  const rootPath = "/data/test-repo";
  const summary = async (id) => agentFor(id).workspaceSummary(id);
  async function ask(id, word) {
    const before = (await summary(id)).lastAssistantMessage;
    await agentFor(id).sendMessage(
      id,
      "Do not use tools. Reply with exactly: " + word,
    );
    const until = Date.now() + 150000;
    while (Date.now() < until) {
      const s = await summary(id);
      if (
        s.lastAssistantMessage &&
        s.lastAssistantMessage !== before &&
        s.lastAssistantMessage.includes(word)
      )
        return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      "Native TUI did not record the requested response before timeout",
    );
  }
  for (let i = 0; i < ids.length; i++) {
    const agent = agents[i];
    stage = "native runtime inference for " + (i === 0 ? "admin" : "teammate");
    await agent.destroyWorkspace(ids[i]).catch(() => {});
    await agent.createWorkspace(
      {
        workspaceId: ids[i].workspaceId,
        repoFullName: "isolated/test",
        repoPath: rootPath,
        branch: "codex-live-328-" + i + "-" + Date.now(),
        baseBranch: "main",
        agent: "codex",
        permissionMode: "default",
      },
      ids[i],
    );
    await agent.setAuth(ids[i], auths[i].credential);
    await agent.setModel(ids[i], { model });
    await agent.startWorkspace(ids[i]);
    if (!resume) {
      await ask(
        ids[i],
        i === 0 ? "OUTRUNNER_ADMIN_LIVE_OK" : "OUTRUNNER_TEAMMATE_LIVE_OK",
      );
      pass(
        "Native runtime/TUI inference through real broker as " +
          (i === 0 ? "admin" : "teammate (no teammate provider login)"),
      );
    }
  }
  stage = "central refresh";
  const current = await codexStore.read(key);
  assert.ok(current);
  let providerRefreshes = 0;
  codexAccounts.renew = (tokens) => renewCodex(tokens, async (url, options) => {
    providerRefreshes++;
    const response = await fetch(url, options);
    console.log("INFO OAuth renewal HTTP " + response.status);
    return response;
  });
  const renewed = await Promise.all(
    Array.from({ length: 12 }, () =>
      codexAccounts.access(key, current.generation, current.revision),
    ),
  );
  const after = await codexStore.read(key);
  assert.equal(after?.revision, current.revision + 1);
  assert.ok(renewed.every((x) => x.revision === after?.revision));
  assert.equal(providerRefreshes, 1);
  pass(
    "12 concurrent real renewal requests completed with one fenced revision",
  );
  stage = "native inference after refresh and restart";
  await agents[1].stopWorkspace(ids[1]);
  await agents[1].resumeWorkspace(ids[1]);
  await ask(ids[1], "OUTRUNNER_REFRESH_RESTART_OK");
  pass(
    "Same-computer native stop/resume and inference succeed after central OAuth renewal",
  );
  stage = "member removal";
  check(
    await db
      .from("organization_members")
      .delete()
      .eq("org_id", state.org)
      .eq("user_id", state.member.id),
  );
  try {
    assert.equal((await request(grants[1])).status, 403);
    await assert.rejects(() => authorizeGrant(readGrant(grants[1].bearer)));
  } finally {
    check(
      await db.from("organization_members").upsert({
        org_id: state.org,
        user_id: state.member.id,
        role: "member",
      }),
    );
  }
  pass(
    "Removed teammate cannot reuse retained runtime grant; membership restored for cleanup",
  );
  stage = "saved authentication choice";
  check(
    await db
      .from("user_agent_auth")
      .upsert({ user_id: state.member.id, agent: "codex", method: "api-key" }),
  );
  try {
    assert.equal((await request(grants[1])).status, 403);
  } finally {
    check(
      await db
        .from("user_agent_auth")
        .delete()
        .eq("user_id", state.member.id)
        .eq("agent", "codex"),
    );
  }
  pass(
    "Saved API-key choice prevents stale account grant use; isolated choice restored",
  );
  writeFileSync(
    root + "/live-results.json",
    JSON.stringify({
      at: new Date().toISOString(),
      passed: true,
      model,
      revision: after?.revision,
    }),
    { mode: 0o600 },
  );
} catch (error) {
  // Never serialize exceptions, request headers, provider bodies or token values.
  const reason =
    error instanceof assert.AssertionError
      ? error.message.slice(0, 200)
      : error instanceof CodexError
        ? error.code
      : "operation failed";
  console.log("FAIL " + stage + ": " + reason);
  process.exitCode = 1;
} finally {
  await cleanup();
}
