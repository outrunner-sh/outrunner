/**
 * Codex on Outrunner's models, on a real Daytona box, through the shipping
 * code: provision a box with this build's agent, make a Codex session, put it
 * on each of Outrunner's models in turn (setModelRequest, as the create route
 * and a switch do) and have it use its tools and edit a file on each, ask it
 * who it is, then stop and resume it and check it remembers the conversation.
 * Along the way: the box says it runs Codex through a gateway (codex-gateway),
 * the key is on no command line and in no process's environment, the
 * session's Codex home is owner-only, and the key's spend went up. The box is
 * deleted at the end.
 *
 *   ./scripts/build-agent.sh
 *   RUNTIME_AGENT_BINARY_PATH=.context/build/runtime-agent-linux-amd64 \
 *     node --experimental-strip-types --import ./scripts/test-loader.mjs \
 *          --env-file=.env.local scripts/verify-codex-gateway.ts
 *
 * Needs DAYTONA_API_KEY and an OpenRouter key. With OPENROUTER_MANAGEMENT_KEY,
 * the session runs on a key of its own capped at the Free plan's allowance,
 * as outrunnerModelKey makes one for a user, which is disabled at the end;
 * without it, on OPENROUTER_API_KEY. Optional: VERIFY_MODELS (comma-separated
 * slugs, default all of OUTRUNNER_MODELS), VERIFY_CODEX_VERSION (install that
 * Codex on the box first: Daytona's base image brings its own), --keep.
 */

import { randomBytes } from "node:crypto";
import { Daytona } from "@daytonaio/sdk";

import { PLANS } from "@/lib/billing/plans";
import { createUserKey, disableUserKey, readCurrentKey } from "@/lib/openrouter/keys";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CODEX_GATEWAY } from "@/lib/runtime/agent-protocol";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { npmInstallGlobal } from "@/lib/runtime/npm-global";
import { OUTRUNNER_MODELS, setModelRequest } from "@/lib/runtime/session-models";

const KEEP = process.argv.includes("--keep");
const wanted = process.env.VERIFY_MODELS?.split(",").map((m) => m.trim());
const models = OUTRUNNER_MODELS.filter((m) => !wanted || wanted.includes(m.id));
const identity: WorkspaceIdentity = { workspaceId: "verify-codex-gateway", projectId: "p", computerId: "c", userId: "u" };
const provider = new DaytonaRuntimeProvider();
const secret = randomBytes(32).toString("hex");
const t0 = performance.now();
const at = () => `${((performance.now() - t0) / 1000).toFixed(0)}s`.padStart(5);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(at(), ok ? "  ok  " : "  FAIL", what);
  if (!ok) failures.push(what);
};

let sandboxId: string | null = null;
let ownKey: { key: string; hash: string } | null = null;
try {
  if (process.env.OPENROUTER_MANAGEMENT_KEY) {
    ownKey = await createUserKey("verify-codex-gateway", PLANS.free.models.usd);
    console.log(at(), `a key of its own, capped at the Free plan's $${PLANS.free.models.usd}`);
  }
  const key = ownKey?.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("Set OPENROUTER_MANAGEMENT_KEY or OPENROUTER_API_KEY.");
  const spentBefore = (await readCurrentKey(key))?.usedUsd ?? 0;

  const computer = await provider.provisionComputer({ secret, repoFullName: "octocat/Hello-World", sessionEnv: {} });
  sandboxId = computer.sandboxId;
  const box = await new Daytona().get(sandboxId);
  // The key never goes on a command line here either: checks read it from a file.
  await box.fs.uploadFile(Buffer.from(key), "/tmp/verify.key");
  // Each check runs from a script file, so no quoting stands between it and bash.
  const sh = async (command: string, timeout = 120) => {
    await box.fs.uploadFile(Buffer.from(command), "/tmp/verify-check.sh");
    const run = await box.process.executeCommand("bash /tmp/verify-check.sh", undefined, undefined, timeout);
    return (run.result ?? "").replaceAll(key, "[key]").trim();
  };
  await sh("chmod 600 /tmp/verify.key");
  if (process.env.VERIFY_CODEX_VERSION) {
    const install = npmInstallGlobal(`@openai/codex@${process.env.VERIFY_CODEX_VERSION}`, { sudo: true });
    console.log(at(), "installing Codex", process.env.VERIFY_CODEX_VERSION, (await sh(`${install} 2>&1 | tail -3`, 300)).slice(-300));
  }
  console.log(at(), "box up:", await sh("codex --version"));

  const agent = new AgentClient(await provider.agentTarget(sandboxId, secret));
  const health = await agent.health(identity);
  check(health.agents?.includes("codex") === true, "the box runs Codex");
  check(health.features?.includes(AGENT_FEATURE_CODEX_GATEWAY) === true, `the box says ${AGENT_FEATURE_CODEX_GATEWAY}`);

  const { worktree } = await agent.createWorkspace(
    { workspaceId: identity.workspaceId, repoFullName: "octocat/Hello-World", branch: "outrunner/codex-check", baseBranch: "master", agent: "codex" },
    identity,
  );
  const pane = () => sh(`tmux capture-pane -p -t ws-${identity.workspaceId} 2>&1 | grep -v '^\\s*$' | tail -15`);
  const putOn = async (model: (typeof models)[number]) =>
    agent.setModel(identity, await setModelRequest(model, async () => key));

  // A turn is over when Codex records its task_complete in the session's
  // rollout, in the session's own Codex home.
  const home = `$(find $HOME -maxdepth 4 -type d -path "*/codex/${identity.workspaceId}" | head -1)`;
  const turnsDone = async () => Number(await sh(`cat ${home}/sessions/*/*/*/*.jsonl 2>/dev/null | grep -c '"task_complete"'`)) || 0;
  /** Send `prompt` and wait for its turn to end, at most `seconds`: the reply. */
  const ask = async (prompt: string, seconds = 240): Promise<string | null> => {
    const before = await turnsDone();
    await agent.sendMessage(identity, prompt);
    for (let i = 0; i < seconds / 3; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if ((await turnsDone()) > before) {
        // The translated conversation, which the Summary reads, follows the rollout.
        await new Promise((r) => setTimeout(r, 1500));
        return (await agent.workspaceSummary(identity)).lastAssistantMessage ?? null;
      }
    }
    console.log(at(), "  no reply; the screen:\n" + (await pane()));
    return null;
  };

  await putOn(models[0]);
  await agent.startWorkspace(identity);
  console.log(at(), `session started on ${models[0].label}`);
  for (const [i, model] of models.entries()) {
    // The first is the model the session started on; each other a switch mid-session.
    if (i > 0) {
      await putOn(model);
      console.log(at(), `switched to ${model.label}`);
    }
    const file = `${model.id.split("/")[1]}.txt`;
    const reply = await ask(
      `Run \`ls\` to list the files here. Then create a file named ${file} containing exactly the text: hello from ${model.label}. Then reply with the list of files you saw.`,
    );
    console.log(at(), `  ${model.label} said:`, JSON.stringify(reply?.slice(0, 300)));
    check(reply !== null && /README/i.test(reply), `${model.label} answered after running ls`);
    const written = await sh(`cat ${worktree}/${file} 2>&1`);
    check(written.includes(`hello from ${model.label}`), `${model.label} wrote ${file} (${JSON.stringify(written.slice(0, 80))})`);
  }

  const who = await ask("In one sentence: who are you, and which model do you run on?", 180);
  console.log(at(), "  asked who it is:", JSON.stringify(who));
  const last = models[models.length - 1];
  // What Codex sent the model as instructions: once at the start, and on a switch.
  console.log(at(), "  developer messages naming a model:", await sh(
    `cat ${home}/sessions/*/*/*/*.jsonl | jq -rc 'select(.type=="response_item" and .payload.role=="developer") | [.payload.content[].text] | join(" ")' | grep -o "say [a-z0-9/.-]*; don" | uniq -c | tr '\n' ';'`,
  ));
  check(who !== null && /outrunner/i.test(who) && !/I am Codex|I'm Codex/i.test(who), "it says it is Outrunner's agent, not Codex");

  // The key: in the session's own Codex home, owner-only, and nowhere else.
  const homePath = await sh(`echo ${home}`);
  check(homePath !== "", `the session has a Codex home of its own (${homePath})`);
  check((await sh(`stat -c %a ${home} ${home}/config.toml`)) === "700\n600", "its home and config.toml are owner-only");
  check((await sh(`grep -c '^model_provider = "openrouter"' ${home}/config.toml`)) === "1", "its config puts Codex on OpenRouter");
  // Which model each turn ran on, as Codex recorded it.
  console.log(at(), "  models the turns ran on:", await sh(`cat ${home}/sessions/*/*/*/*.jsonl | jq -rc 'select(.type=="turn_context") | .payload.model' | uniq -c | tr '\n' ';'`));
  const onArgv = await sh(`for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -qF -f /tmp/verify.key && echo $p; done; true`);
  check(onArgv === "", `the key is on no command line ${onArgv}`);
  const inEnv = await sh(
    `for p in $(pgrep -f 'codex' | grep -v $$); do grep -qF -f /tmp/verify.key /proc/$p/environ 2>/dev/null && echo $p; done; true`,
  );
  check(inEnv === "", `the key is in no Codex process's environment ${inEnv}`);
  // What Codex's own commands see: it saves its environment to a file, which
  // is checked here, not the model's account of it.
  await sh("rm -f /tmp/codex-command-env.txt");
  await ask("Run exactly `env > /tmp/codex-command-env.txt` and reply done.", 180);
  const commandEnv = await sh("wc -l < /tmp/codex-command-env.txt");
  check(Number(commandEnv) > 0, `Codex's command saved its environment (${commandEnv} lines)`);
  const leaked = await sh(
    "{ grep -F -f /tmp/verify.key /tmp/codex-command-env.txt; grep -E '^(OPENROUTER|CODEX_GATEWAY)' /tmp/codex-command-env.txt; } | wc -l",
  );
  check(leaked === "0", `Codex's commands see neither the key nor an OPENROUTER*/CODEX_GATEWAY* variable (${leaked} found)`);

  // A relaunch (stopped, then resumed: what an attach after an exit does)
  // goes back on the model and continues the conversation.
  await agent.stopWorkspace(identity);
  await agent.resumeWorkspace(identity);
  console.log(at(), "stopped and resumed");
  const remembered = await ask("Which .txt files have you created in this session? Answer with just their names.", 180);
  console.log(at(), "  after the relaunch:", JSON.stringify(remembered));
  check(models.every((m) => remembered?.includes(m.id.split("/")[1])), "after the relaunch it remembers every file it made");
  check((await pane()).includes(last.id) || (await sh(`ps -eo args | grep -F -- '-m ${last.id}' | grep -v grep | wc -l`)) !== "0", `it relaunched on ${last.label}`);

  // Settle OpenRouter's accounting before reading the key's spend.
  await new Promise((r) => setTimeout(r, 15000));
  const spent = await readCurrentKey(key);
  const delta = (spent?.usedUsd ?? 0) - spentBefore;
  console.log(at(), `the key spent $${delta.toFixed(4)} (of ${spent?.limitUsd === null ? "no cap" : `$${spent?.limitUsd}`}, $${spent?.remainingUsd ?? "?"} left)`);
  check(delta > 0, "the session's use shows on its key");
} catch (error) {
  console.log(at(), "FAILED:", error);
  failures.push(String(error));
} finally {
  if (sandboxId && !KEEP) {
    await provider.destroyComputerOrThrow(sandboxId).then(() => console.log(at(), "box deleted"), (e) => console.log("! delete failed", e));
  } else if (sandboxId) {
    console.log(at(), `--keep: box ${sandboxId} left running`);
  }
  if (ownKey) await disableUserKey(ownKey.hash).then(() => console.log(at(), "its key disabled"), (e) => console.log("! disabling the key failed", e));
}
console.log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
