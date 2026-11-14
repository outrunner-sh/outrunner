import assert from "node:assert/strict";
import { test } from "node:test";

import { artifactJson } from "@/lib/api/artifacts";
import type { Media } from "@/lib/db/media";

const media = (extra: Partial<Media> = {}): Media => ({
  id: "6f1c0000-0000-4000-8000-000000000001",
  publicId: "A".repeat(43),
  orgId: "org",
  ownerId: "user",
  workspaceId: "ws",
  name: "Header on mobile, after",
  contentType: "image/png",
  sizeBytes: 48211,
  access: "public",
  storagePath: "org/6f1c",
  createdAt: "2026-11-14T10:00:00Z",
  ...extra,
});

test("an artifact has its link and the line that shows it in a pull request", () => {
  const json = artifactJson(media(), "https://app.outrunner.sh");
  assert.equal(json.url, `https://app.outrunner.sh/m/${"A".repeat(43)}.png`);
  assert.equal(json.markdown, `![Header on mobile, after](https://app.outrunner.sh/m/${"A".repeat(43)}.png)`);
  assert.equal(json.content_type, "image/png");
  assert.equal("storage_path" in json, false);
});

test("a recording is linked, not shown", () => {
  const json = artifactJson(media({ contentType: "video/mp4", access: "private", name: "Checkout flow" }), "https://app.outrunner.sh/");
  assert.match(String(json.markdown), /^\[Checkout flow\]\(https:\/\/app\.outrunner\.sh\/m\/A+\.mp4\)$/);
  assert.equal(json.access, "private");
});
