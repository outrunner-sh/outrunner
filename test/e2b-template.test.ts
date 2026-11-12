import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { boxBuildArgs } from "@/lib/runtime/box-image";
import { e2bDockerfile, isUserE2bTemplateName, userE2bTemplateName } from "@/lib/runtime/e2b-template";

test("box/Dockerfile becomes one E2B can build: pins written in, args and their guard gone", () => {
  const dockerfile = readFileSync(new URL("../box/Dockerfile", import.meta.url), "utf8");
  const args = boxBuildArgs();
  const text = e2bDockerfile(dockerfile, args);
  assert.doesNotMatch(text, /^ARG /m);
  assert.doesNotMatch(text, /^RUN test -n/m);
  assert.doesNotMatch(text, /^# syntax=/m);
  for (const name of Object.keys(args)) assert.doesNotMatch(text, new RegExp(`\\$\\{?${name}\\b`));
  assert.ok(text.includes(args.CLAUDE_CODE_VERSION));
  assert.match(text, new RegExp(`@openai/codex@${args.CODEX_VERSION}`));

  // With an MTU, the build VM is set to it before its first download.
  const lines = e2bDockerfile(dockerfile, args, 1460).split("\n");
  const from = lines.findIndex((line) => line.startsWith("FROM "));
  assert.deepEqual(lines.slice(from + 1, from + 3), ["USER root", "RUN ip link set eth0 mtu 1460"]);
});

test("an arg left unset fails the build rather than ship an image without it", () => {
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG X\nARG Y\nRUN echo $X $Y\n", { X: "1" }), /refers to Y/);
  // `$X` without braces is written in too, and a longer name sharing its start is left alone.
  assert.equal(e2bDockerfile('FROM ubuntu\nARG X\nARG X_SUM\nRUN echo "$X" $X_SUM\n', { X: "1", X_SUM: "ab" }), 'FROM ubuntu\nRUN echo "1" ab\n');
  assert.equal(e2bDockerfile("FROM ubuntu\nARG X\nRUN echo ${X}\n", { X: "1" }), "FROM ubuntu\nRUN echo 1\n");
});

test("an ARG box/Dockerfile adds later can't silently expand to nothing", () => {
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG FOO=bar\nRUN echo ${FOO}\n", { X: "1" }), /refers to FOO/);
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG FOO\nRUN echo $FOO\n", {}), /refers to FOO/);
  // Docker's default and alternate forms too, which would quietly take the default.
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG FOO\nRUN echo ${FOO:-latest}\n", {}), /refers to FOO/);
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG FOO\nRUN echo ${FOO:+set}\n", {}), /refers to FOO/);
  // Declared but unused is fine: nothing would expand to nothing.
  assert.equal(e2bDockerfile("FROM ubuntu\nARG FOO\nRUN echo hi\n", {}), "FROM ubuntu\nRUN echo hi\n");
});

test("a user's template is named for the image and the user", () => {
  assert.equal(userE2bTemplateName("0b8a3ded-4489-4722-afd1-1d82e64ec2d5", "2fe23c90ef49"), "outrunner-box-2fe23c90ef49-0b8a3ded");
});

test("only the user's own Outrunner templates are taken for theirs to clean up", () => {
  const user = "0b8a3ded-4489-4722-afd1-1d82e64ec2d5";
  assert.equal(isUserE2bTemplateName("outrunner-box-2fe23c90ef49-0b8a3ded", user), true);
  assert.equal(isUserE2bTemplateName("team-slug/outrunner-box-aaaaaaaaaaaa-0b8a3ded", user), true);
  assert.equal(isUserE2bTemplateName("team-slug/outrunner-box-aaaaaaaaaaaa-0b8a3ded:default", user), true);
  assert.equal(isUserE2bTemplateName("outrunner-box-2fe23c90ef49-11111111", user), false);
  assert.equal(isUserE2bTemplateName("my-outrunner-box-2fe23c90ef49-0b8a3ded", user), false);
  assert.equal(isUserE2bTemplateName("base", user), false);
  // A tag in another form than today's, hyphens included, still counts as theirs.
  assert.equal(isUserE2bTemplateName("outrunner-box-2026-11-12-0b8a3ded", user), true);
  assert.equal(isUserE2bTemplateName("outrunner-box-2026-11-12-11111111", user), false);
});
