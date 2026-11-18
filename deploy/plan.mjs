#!/usr/bin/env node
// Decides whether, and what, the production deploy ships (.github/workflows/
// deploy.yml's plan job): a commit of main, deployed only once the code in it
// was tested exactly as it is, from the image CI built for its tree.
//
// A commit was tested as is when main's CI passed on it, or when a pull
// request merged in it ran green with the very same tree: a pull request that
// was up to date with main when merged. That one deploys at once, its image
// already built by its run; any other waits for main's CI, whose run builds
// the image. An automatic run whose commit is no longer main's head stands
// down: the head's run deploys it.
//
//   node deploy/plan.mjs   (env: GH_TOKEN, GITHUB_REPOSITORY, EVENT, SHA,
//                           BUILD_ON_VM, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY)
//
// Outputs: sha, deploy (true/false), image ("" to build on the VM).
import { appendFileSync } from "node:fs";

/** The decision, from what's known now. One of:
 *  { action: "deploy", image } | { action: "wait", why } | { action: "stand-down", why } | { action: "fail", why } */
export function decide(s) {
  if (s.event === "push" && s.sha !== s.head) {
    return { action: "stand-down", why: `main's head is now ${s.head.slice(0, 12)}; its deploy ships this commit` };
  }
  const tested = s.mainCI === "success" || s.testedBy !== null;
  if (!tested) {
    if (s.mainCI === "failure") return { action: "fail", why: `CI failed on main for ${s.sha.slice(0, 12)}, and no pull request tested its tree as is` };
    if (s.event === "workflow_dispatch" && s.mainCI === "none") return { action: "fail", why: `CI never ran on main for ${s.sha.slice(0, 12)}: only a commit main's CI passed deploys` };
    return { action: "wait", why: "main's CI: this commit's tree wasn't tested as is (its pull request was behind main)" };
  }
  if (s.buildOnVm) return { action: "deploy", image: "" };
  if (s.imageExists) return { action: "deploy", image: s.image };
  // A commit from before images (a rollback by hand) is built on the VM, as
  // it was then; the VM activates one it still has without building it.
  if (s.event === "workflow_dispatch") return { action: "deploy", image: "" };
  if (s.mainCI === "success") return { action: "fail", why: `main's CI passed but built no image for tree ${s.tree.slice(0, 12)}` };
  return { action: "wait", why: `the image of tree ${s.tree.slice(0, 12)} (main's CI builds it)` };
}

/** A run's state, from GitHub's list: "success", "failure", "pending" or "none". */
export function runState(runs) {
  if (runs.length === 0) return "none";
  // The newest run of the commit, which a re-run of a flake supersedes.
  const run = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "success" : "failure";
}

/** Everything decide() needs, read from GitHub and the registry. */
export async function gather({ github, registry, repo, event, sha, buildOnVm }) {
  const treeOf = async (commit) => (await github(`/repos/${repo}/git/commits/${commit}`)).tree.sha;
  const [head, tree, pulls, mainRuns] = await Promise.all([
    github(`/repos/${repo}/commits/main`).then((c) => c.sha),
    treeOf(sha),
    github(`/repos/${repo}/commits/${sha}/pulls`),
    github(`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`),
  ]);
  let testedBy = null;
  for (const pull of pulls) {
    if (!pull.merged_at || (await treeOf(pull.head.sha)) !== tree) continue;
    const runs = await github(`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=20`);
    if (runState(runs.workflow_runs) === "success") testedBy = pull.number;
  }
  const image = `ghcr.io/${repo.toLowerCase()}/control-plane:tree-${tree}`;
  return {
    event, sha, head, tree, testedBy, buildOnVm, image,
    mainCI: runState(mainRuns.workflow_runs),
    imageExists: buildOnVm ? false : await registry(image),
  };
}

/** GitHub's REST API, as the run's token. */
function githubApi(token) {
  return async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
}

/** Whether ghcr.io has `image`, asked with the run's token. */
function ghcr(token) {
  return async (image) => {
    const [, name, tag] = /^ghcr\.io\/(.+):([^:]+)$/.exec(image);
    const auth = await fetch(`https://ghcr.io/token?scope=repository:${name}:pull`, {
      headers: { Authorization: `Basic ${Buffer.from(`token:${token}`).toString("base64")}` },
    });
    if (!auth.ok) throw new Error(`ghcr.io token: ${auth.status}`);
    const { token: bearer } = await auth.json();
    const manifest = await fetch(`https://ghcr.io/v2/${name}/manifests/${tag}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (manifest.status === 404) return false;
    if (!manifest.ok) throw new Error(`ghcr.io ${image}: ${manifest.status}`);
    return true;
  };
}

async function main() {
  const env = process.env;
  for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY", "EVENT", "SHA", "GITHUB_OUTPUT"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const input = {
    github: githubApi(env.GH_TOKEN),
    registry: ghcr(env.GH_TOKEN),
    repo: env.GITHUB_REPOSITORY,
    event: env.EVENT,
    sha: env.SHA,
    buildOnVm: env.BUILD_ON_VM === "true",
  };
  const deadline = Date.now() + Number(env.PLAN_WAIT_MINUTES ?? 25) * 60_000;
  const summary = (line) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  const output = (values) => appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
  let said = "";
  for (;;) {
    const state = await gather(input);
    const decision = decide(state);
    if (decision.action === "deploy") {
      const how = decision.image ? `the image of tree \`${state.tree.slice(0, 12)}\`` : "an image built on the VM";
      const why = state.testedBy !== null ? `tested as is by #${state.testedBy}` : "CI passed on main";
      console.log(`Deploying ${state.sha} (${why}) from ${how}`);
      summary(`Deploying \`${state.sha.slice(0, 12)}\`: ${why}, from ${how}.`);
      output({ sha: state.sha, deploy: "true", image: decision.image });
      return;
    }
    if (decision.action === "stand-down") {
      console.log(`::notice::Not deploying ${state.sha}: ${decision.why}`);
      summary(`Skipped: ${decision.why}.`);
      output({ sha: state.sha, deploy: "false", image: "" });
      return;
    }
    if (decision.action === "fail") {
      console.log(`::error::Nothing was deployed: ${decision.why}`);
      summary(`Nothing was deployed: ${decision.why}.`);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.log(`::error::Nothing was deployed: still waiting for ${decision.why}`);
      process.exit(1);
    }
    if (decision.why !== said) console.log(`Waiting for ${(said = decision.why)}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
