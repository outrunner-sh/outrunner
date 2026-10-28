import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorUserId } from "@/lib/automations/connector-id";
import { isUuid } from "@/lib/ids";

test("an org's connector has one id, the same however often it's asked", () => {
  const org = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
  const id = connectorUserId(org);
  assert.equal(connectorUserId(org), id);
  assert.ok(isUuid(id), id);
  assert.equal(id[14], "5"); // a name-based (version 5) UUID
  assert.notEqual(connectorUserId("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), id);
});
