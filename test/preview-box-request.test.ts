import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRequestSignature, previewRequestValid } from "@/lib/previews/box-request";
import { gitCredentialSignature } from "@/lib/runtime/git-credential";

const BODY = JSON.stringify({ workspaceId: "55555555-5555-4555-8555-555555555555", port: 3000, label: "Web" });

test("a box signs a preview request as the agent does (runtime-agent/internal/preview)", () => {
  // The same vector is in preview_test.go.
  assert.equal(
    previewRequestSignature("box-secret", "sandbox-1", "1762182000", BODY),
    "sha256=1c039b010f36c44c9592a5c97768b6e6e542a33727e05b577b81e89183b514fb",
  );
});

test("a preview request is good only signed for previews, by its box, recently", () => {
  const now = 1762182000;
  const signed = { sandboxId: "sandbox-1", timestamp: String(now), body: BODY };
  const signature = previewRequestSignature("box-secret", "sandbox-1", String(now), BODY);
  assert.equal(previewRequestValid("box-secret", { ...signed, signature }, now), true);
  assert.equal(previewRequestValid("other-secret", { ...signed, signature }, now), false);
  assert.equal(previewRequestValid("box-secret", { ...signed, sandboxId: "sandbox-2", signature }, now), false);
  assert.equal(previewRequestValid("box-secret", { ...signed, body: BODY.replace("3000", "8080"), signature }, now), false);
  assert.equal(previewRequestValid("box-secret", { ...signed, signature }, now + 301), false);
  // A git credential's signature is never a preview's.
  const git = gitCredentialSignature("box-secret", "sandbox-1", String(now), BODY);
  assert.equal(previewRequestValid("box-secret", { ...signed, signature: git }, now), false);
});
