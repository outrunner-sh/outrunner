import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { boxBuildArgs } from "@/lib/runtime/box-image";
import { e2bDockerfile } from "@/lib/runtime/e2b-template";

test("box/Dockerfile becomes one E2B can build: pins written in, args and their guard gone", () => {
  const dockerfile = readFileSync(new URL("../box/Dockerfile", import.meta.url), "utf8");
  const args = boxBuildArgs();
  const text = e2bDockerfile(dockerfile, args);
  assert.doesNotMatch(text, /^ARG /m);
  assert.doesNotMatch(text, /^RUN test -n/m);
  assert.doesNotMatch(text, /^# syntax=/m);
  assert.doesNotMatch(text, /\$\{?(NODE_MAJOR|CLAUDE_CODE_VERSION|CODEX_VERSION|GH_VERSION)\b/);
  assert.match(text, new RegExp(`install.sh \\| bash -s "${args.CLAUDE_CODE_VERSION}"`));
  assert.match(text, new RegExp(`@openai/codex@${args.CODEX_VERSION}`));

  // With an MTU, the build VM is set to it before its first download.
  const lines = e2bDockerfile(dockerfile, args, 1460).split("\n");
  const from = lines.findIndex((line) => line.startsWith("FROM "));
  assert.deepEqual(lines.slice(from + 1, from + 3), ["USER root", "RUN ip link set eth0 mtu 1460"]);
});

test("an arg left unset fails the build rather than ship an image without it", () => {
  // `$X` without braces isn't one E2B's text can be given a value for.
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG X\nRUN echo $X\n", { X: "1" }), /refers to X/);
  assert.equal(e2bDockerfile("FROM ubuntu\nARG X\nRUN echo ${X}\n", { X: "1" }), "FROM ubuntu\nRUN echo 1\n");
});

test("an ARG box/Dockerfile adds later can't silently expand to nothing", () => {
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG FOO=bar\nRUN echo ${FOO}\n", { X: "1" }), /refers to FOO/);
  assert.throws(() => e2bDockerfile("FROM ubuntu\nARG FOO\nRUN echo $FOO\n", {}), /refers to FOO/);
  // Declared but unused is fine: nothing would expand to nothing.
  assert.equal(e2bDockerfile("FROM ubuntu\nARG FOO\nRUN echo hi\n", {}), "FROM ubuntu\nRUN echo hi\n");
});
