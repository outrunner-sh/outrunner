import assert from "node:assert/strict";
import { test } from "node:test";

import { EnvironmentRuleError } from "@/lib/environments/rules";
import {
  catalogSkill,
  committedItems,
  installName,
  registryRepo,
  skillFoldersIn,
  skillFrontMatter,
  skillSources,
} from "@/lib/environments/skills";
import { committedSkills, registrySkills, searchSkillCatalog, SkillCatalogError } from "@/lib/github/skills";

test("a catalog skill is a skill of a GitHub repository, named by its slug", () => {
  assert.deepEqual(catalogSkill({ name: "pdf", slug: "anthropics/skills/pdf", source: "anthropics/skills" }), {
    slug: "anthropics/skills/pdf",
    name: "pdf",
    source: "anthropics/skills",
    skill: "pdf",
  });
  // The catalog's name stands; a missing one is the skill's own.
  assert.equal(catalogSkill({ slug: "vercel-labs/agent-skills/react", source: "vercel-labs/agent-skills" }).name, "react");
  for (const input of [
    { slug: "open.feishu.cn/lark-event", source: "open.feishu.cn" },
    { slug: "acme/skills/pdf", source: "other/skills" },
    { slug: "acme/skills/../x", source: "acme/skills" },
    { slug: "", source: "acme/skills" },
    {},
  ]) {
    assert.throws(() => catalogSkill(input), EnvironmentRuleError, JSON.stringify(input));
  }
});

test("a registry is given as owner/name or any address GitHub shows for it", () => {
  for (const given of [
    "acme/skills",
    "https://github.com/acme/skills",
    "https://github.com/acme/skills.git",
    "https://github.com/acme/skills/",
    "https://github.com/acme/skills/tree/main/skills",
    "git@github.com:acme/skills.git",
    "github.com/acme/skills",
    "  acme/skills  ",
  ]) {
    assert.equal(registryRepo(given), "acme/skills", given);
  }
  for (const given of ["acme", "https://gitlab.com/acme/skills", "acme/skills/extra", "../x/y", "", 42]) {
    assert.throws(() => registryRepo(given), EnvironmentRuleError, String(given));
  }
});

test("a SKILL.md's name and description are read from its front matter", () => {
  assert.deepEqual(skillFrontMatter('---\nname: "pdf"\ndescription: Fill PDF forms.\nlicense: MIT\n---\n# PDF\n'), {
    name: "pdf",
    description: "Fill PDF forms.",
  });
  assert.deepEqual(skillFrontMatter("# No front matter\nname: x\n"), { name: null, description: null });
  // Top-level keys only, the last one winning: the same case as the box's
  // TestSkillManifestNameIsTheTopLevelLastOne.
  assert.equal(skillFrontMatter('---\nname: first\nmetadata:\n  name: nested\nname: "last"\n---\nname: body\n').name, "last");
  assert.equal(skillFrontMatter("---\ndescription: x\nmetadata:\n  name: nested\n---\n").name, null);
  assert.equal(skillFrontMatter("---\r\nname: 'crlf'\r\n---\r\n").name, "crlf");
  // A folded description isn't on its line: none, rather than ">".
  assert.equal(skillFrontMatter("---\nname: x\ndescription: >\n  long\n---\n").description, null);
});

test("skills are found as the box finds them: folders with a SKILL.md, not in a skill or a skipped folder", () => {
  const paths = [
    "README.md",
    "skills/pdf/SKILL.md",
    "skills/pdf/scripts/SKILL.md",
    "skills/docx/SKILL.md",
    "node_modules/x/SKILL.md",
    "a/b/c/d/e/f/g/SKILL.md",
    ".claude/skills/deploy/SKILL.md",
  ];
  assert.deepEqual(skillFoldersIn(paths), [
    { path: ".claude/skills/deploy", folder: "deploy" },
    { path: "skills/docx", folder: "docx" },
    { path: "skills/pdf", folder: "pdf" },
  ]);
  // A repository that is one skill holds it at its root; one that is a
  // skill and holds others is a collection of the others.
  assert.deepEqual(skillFoldersIn(["SKILL.md", "notes.md"]), [{ path: "", folder: "" }]);
  assert.deepEqual(skillFoldersIn(["SKILL.md", "extra/SKILL.md"]), [{ path: "extra", folder: "extra" }]);
  assert.deepEqual(skillFoldersIn(["SKILL.md", "extra/SKILL.md"], true), [
    { path: "", folder: "" },
    { path: "extra", folder: "extra" },
  ]);
  assert.equal(installName("vercel-react-best-practices", "react-best-practices"), "vercel-react-best-practices");
  assert.equal(installName("has spaces", "folder"), "folder");
  assert.equal(installName(null, ""), null);
});

test("what a repository commits for its agents is listed by kind", () => {
  assert.deepEqual(
    committedItems([
      ".claude/skills/review/SKILL.md",
      ".claude/skills/review/notes.md",
      ".agents/skills/fmt/SKILL.md",
      ".claude/agents/scout.md",
      ".claude/commands/ship.md",
      ".claude/commands/git/push.md",
      ".claude/settings.json",
      "docs/SKILL.md",
    ]),
    [
      { path: ".agents/skills/fmt", kind: "skill", framework: "codex" },
      { path: ".claude/agents/scout.md", kind: "agent", framework: "claude" },
      { path: ".claude/commands/git/push.md", kind: "command", framework: "claude" },
      { path: ".claude/commands/ship.md", kind: "command", framework: "claude" },
      { path: ".claude/skills/review", kind: "skill", framework: "claude" },
    ],
  );
});

test("a session sends selected skills beside a registry of the same repository", () => {
  const skill = (source: string, name: string) => ({ slug: `${source}/${name}`, name, source, skill: name });
  assert.deepEqual(
    skillSources(
      [
        skill("anthropics/skills", "pdf"),
        skill("anthropics/skills", "docx"),
        skill("acme/skills", "lint"),
        skill("acme/skills", "vercel-react-best-practices"),
        skill("other/x", "y"),
      ],
      [
        { fullName: "Acme/Skills", branch: "main", token: "ghs_x" },
        { fullName: "acme/public", branch: "trunk" },
      ],
    ),
    [
      { repo: "anthropics/skills", skills: ["pdf", "docx"] },
      { repo: "Acme/Skills", ref: "main", token: "ghs_x", skills: ["lint", "vercel-react-best-practices"] },
      { repo: "other/x", skills: ["y"] },
      { repo: "Acme/Skills", ref: "main", token: "ghs_x" },
      { repo: "acme/public", ref: "trunk" },
    ],
  );
});

/** A fetch that answers by URL prefix, and counts what it was asked. */
function fakeFetch(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${url} ${new Headers(init?.headers).get("authorization") ?? ""}`.trim());
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const body = answers[key];
    return typeof body === "string" ? new Response(body) : Response.json(body);
  }) as typeof fetch;
  return { doFetch, asked };
}

test("the catalog's search is read leniently, and its failure said", async () => {
  const { doFetch, asked } = fakeFetch({
    "https://skills.sh/api/search": {
      skills: [
        { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 219011 },
        { id: "open.feishu.cn/lark-event", source: "open.feishu.cn", skillId: "lark-event", name: "lark-event", installs: 5 },
        { nonsense: true },
      ],
    },
  });
  assert.deepEqual(await searchSkillCatalog("pdf", 20, doFetch), [
    { name: "pdf", slug: "anthropics/skills/pdf", source: "anthropics/skills", installs: 219011, github: true },
    { name: "lark-event", slug: "open.feishu.cn/lark-event", source: "open.feishu.cn", installs: 5, github: false },
  ]);
  assert.match(asked[0], /q=pdf&limit=20/);
  await assert.rejects(searchSkillCatalog("pdf", 20, fakeFetch({}).doFetch), SkillCatalogError);
});

test("a registry's skills are listed from its tree, named as the box installs them", async () => {
  const { doFetch, asked } = fakeFetch({
    "https://api.github.com/repos/acme/skills/git/trees/main?recursive=1": {
      tree: [
        { path: "skills/react/SKILL.md", type: "blob" },
        { path: "skills/react", type: "tree" },
        { path: "lint/SKILL.md", type: "blob" },
      ],
    },
    "https://api.github.com/repos/acme/skills/contents/skills/react/SKILL.md": "---\nname: vercel-react\ndescription: React rules.\n---\n",
    "https://api.github.com/repos/acme/skills/contents/lint/SKILL.md": "# Lint\n",
  });
  assert.deepEqual(await registrySkills("ghs_x", "acme/skills", "main", doFetch), [
    { name: "lint", description: null, path: "lint", htmlUrl: "https://github.com/acme/skills/tree/main/lint" },
    {
      name: "vercel-react",
      description: "React rules.",
      path: "skills/react",
      htmlUrl: "https://github.com/acme/skills/tree/main/skills/react",
    },
  ]);
  assert.ok(asked.every((a) => a.endsWith("Bearer ghs_x")), "read with the token");
  assert.equal(await registrySkills(null, "acme/gone", "main", doFetch), null);
});

test("a repository's committed skills, subagents and commands are named from their files", async () => {
  const { doFetch } = fakeFetch({
    "https://api.github.com/repos/acme/web/git/trees/develop?recursive=1": {
      tree: [
        { path: ".claude/skills/review/SKILL.md", type: "blob" },
        { path: ".claude/agents/scout.md", type: "blob" },
      ],
    },
    // Without a token, files come from GitHub's raw files, not its API.
    "https://raw.githubusercontent.com/acme/web/develop/.claude/skills/review/SKILL.md": "---\nname: review\ndescription: Review PRs.\n---\n",
    "https://raw.githubusercontent.com/acme/web/develop/.claude/agents/scout.md": "You scout.\n",
  });
  assert.deepEqual(await committedSkills(undefined, "acme/web", "develop", doFetch), [
    {
      path: ".claude/agents/scout.md",
      kind: "agent",
      framework: "claude",
      name: "scout",
      description: null,
      htmlUrl: "https://github.com/acme/web/blob/develop/.claude/agents/scout.md",
    },
    {
      path: ".claude/skills/review",
      kind: "skill",
      framework: "claude",
      name: "review",
      description: "Review PRs.",
      htmlUrl: "https://github.com/acme/web/tree/develop/.claude/skills/review",
    },
  ]);
});
