import assert from "node:assert/strict";
import { test } from "node:test";

import { countLines, lineKind } from "@/lib/review/line-kinds";

test("lockfiles anywhere in the tree are generated", () => {
  for (const path of ["pnpm-lock.yaml", "web/package-lock.json", "yarn.lock", "go.sum", "Cargo.lock", "api/poetry.lock", "Gemfile.lock", "infra/.terraform.lock.hcl"]) {
    assert.equal(lineKind(path), "generated", path);
  }
});

test("snapshots, generated paths and vendored code are generated", () => {
  for (const path of [
    "src/__snapshots__/button.test.tsx.snap",
    "ui/button.snap",
    "lib/graphql/__generated__/types.ts",
    "proto/generated/user.ts",
    "api/user.pb.go",
    "api/user_pb2.py",
    "schema.generated.ts",
    "vendor/github.com/pkg/errors/errors.go",
    "third_party/zlib/zlib.h",
    "public/app.min.js",
  ]) {
    assert.equal(lineKind(path), "generated", path);
  }
});

test("tests are found by folder and by name", () => {
  for (const path of [
    "test/review.test.ts",
    "src/__tests__/a.ts",
    "lib/foo.test.ts",
    "lib/foo.spec.tsx",
    "runtime-agent/server_test.go",
    "app/tests/helpers.py",
    "test_api.py",
    "spec/models/user_spec.rb",
    "src/main/java/com/acme/UserServiceTest.java",
    "e2e/login.ts",
    "lib/runtime/replay/conversation.fixtures.json",
  ]) {
    assert.equal(lineKind(path), "test", path);
  }
});

test("everything else is code, and names that only look alike stay code", () => {
  for (const path of ["lib/review/pulls.ts", "src/Latest.java", "contest.py", "docs/github-app.md", "lib/testing-library-free.ts", "lockfile.ts", "lib/distance.ts"]) {
    assert.equal(lineKind(path), "code", path);
  }
});

test("lines are summed by kind", () => {
  assert.deepEqual(
    countLines([
      { path: "lib/a.ts", additions: 10, deletions: 2 },
      { path: "lib/b.ts", additions: 1, deletions: 1 },
      { path: "test/a.test.ts", additions: 30, deletions: 0 },
      { path: "pnpm-lock.yaml", additions: 900, deletions: 400 },
    ]),
    {
      code: { additions: 11, deletions: 3 },
      test: { additions: 30, deletions: 0 },
      generated: { additions: 900, deletions: 400 },
    },
  );
});
