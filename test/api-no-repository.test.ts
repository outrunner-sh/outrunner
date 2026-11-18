import assert from "node:assert/strict";
import { test } from "node:test";

import { noRepositoryAnswer, type NoRepositoryInput } from "@/lib/api/no-repository";

const base: NoRepositoryInput = {
  fullName: "Walkover-Web-Solution/viasocket",
  org: { id: "org-1", name: "walkover", personal: false },
  orgId: "org-1",
  callerKind: "personal_key",
  githubConnected: false,
  base: "https://app.outrunner.sh",
};

async function body(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; status: number; settings_url?: string } }).error;
}

test("a team org with no GitHub connected says so, and where an admin connects it", async () => {
  const response = noRepositoryAnswer(base);
  assert.equal(response.status, 404);
  const error = await body(response);
  assert.equal(error.code, "not_found");
  assert.match(error.message, /walkover \(org-1\): it has no GitHub connected yet, so it has no repositories/);
  assert.equal(error.settings_url, "https://app.outrunner.sh/settings/org/github");
});

test("connected, unknown, or a personal org (its own GitHub counts): add it, or check the org", async () => {
  for (const input of [
    { ...base, githubConnected: true },
    { ...base, githubConnected: null },
    { ...base, org: { id: "org-1", name: "Harsh", personal: true } },
  ]) {
    const error = await body(noRepositoryAnswer(input));
    assert.match(error.message, /that you can see: add it to Outrunner \(Projects → Sync repositories\), or check the org/);
    assert.match(error.message, /A personal key or the CLI acts in your personal org/);
    assert.equal(error.settings_url, undefined);
  }
  const orgKey = await body(noRepositoryAnswer({ ...base, githubConnected: true, callerKind: "org_key" }));
  assert.match(orgKey.message, /An org key acts in its own org alone/);
  // The org couldn't be read: named by id.
  const unread = await body(noRepositoryAnswer({ ...base, org: null }));
  assert.match(unread.message, /in the org org-1 that you can see/);
});
