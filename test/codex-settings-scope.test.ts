import assert from "node:assert/strict";
import { test } from "node:test";
import { codexSettingsScope } from "@/lib/codex/settings-scope";
import type { Org } from "@/lib/orgs/active";
const admin: Org = { id: "team", name: "Team", role: "admin", personal: false };
test("Personal Codex stays private even with an active shared organization", () => {
  assert.deepEqual(codexSettingsScope([admin]), { kind: "personal" });
});
test("Organization Codex reflects current admin/member ownership and fails closed on removal", () => {
  assert.deepEqual(codexSettingsScope([admin], "team"), {
    kind: "org",
    org: admin,
  });
  const member = { ...admin, role: "member" as const };
  assert.deepEqual(codexSettingsScope([member], "team"), {
    kind: "org",
    org: member,
  });
  for (const requested of ["other-org", "", "removed-org"])
    assert.deepEqual(codexSettingsScope([admin], requested), {
      kind: "unavailable",
    });
  assert.deepEqual(codexSettingsScope([{ ...admin, personal: true }], "team"), {
    kind: "unavailable",
  });
  assert.deepEqual(codexSettingsScope([], "team"), { kind: "unavailable" });
});
