import assert from "node:assert/strict";
import { test } from "node:test";

import { ImportError } from "@/lib/imports/commit";
import { commitConfig, configArchivePath } from "@/lib/imports/config";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ARCHIVE = configArchivePath(OWNER, "22222222-2222-4222-8222-222222222222");
const sha = `sha256:${"5".repeat(64)}`;

test("an imported setup replaces the last one, whose archive is deleted", async () => {
  const removed: string[] = [];
  const saved: unknown[] = [];
  await commitConfig(
    OWNER,
    { archive: { path: ARCHIVE, sha256: sha, size: 100 }, items: ["claude-md"], mcpServers: { t: { url: "https://x" } }, settings: {} },
    {
      storedSize: async () => 100,
      save: async (config) => {
        saved.push(config);
        return "archives/old.tar.gz";
      },
      remove: async (path) => void removed.push(path),
    },
  );
  assert.equal(saved.length, 1);
  assert.deepEqual(removed, ["archives/old.tar.gz"]);
});

test("an archive not where this user's goes, or not fully uploaded, is refused unsaved", async () => {
  const other = configArchivePath("33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222");
  for (const [archive, size, status] of [
    [{ path: other, sha256: sha, size: 100 }, 100, 400],
    [{ path: `archives/${OWNER}/../x.tar.gz`, sha256: sha, size: 100 }, 100, 400],
    [{ path: ARCHIVE, sha256: sha, size: 100 }, 99, 409],
  ] as const) {
    let saves = 0;
    await assert.rejects(
      commitConfig(OWNER, { archive, items: [], mcpServers: {}, settings: {} }, {
        storedSize: async () => size,
        save: async () => {
          saves++;
          return null;
        },
        remove: async () => {},
      }),
      (e: unknown) => e instanceof ImportError && e.status === status,
    );
    assert.equal(saves, 0);
  }
});
