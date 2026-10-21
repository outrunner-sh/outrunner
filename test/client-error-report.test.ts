import assert from "node:assert/strict";
import { test } from "node:test";

import { ClientFault, clientFaultLine } from "@/lib/http/client-error-report";

test("a fault report is accepted with its ref, session, and structural detail", () => {
  const report = ClientFault.safeParse({
    where: "events-stream",
    ref: "a1b2c3d4",
    message: "Events frame did not match AgentEvent schema",
    workspaceId: "3f2a8d1e-0000-4000-8000-000000000000",
    eventId: "812",
    eventType: "usage",
    issues: [{ code: "invalid_type", path: ["content"], message: "Expected array" }],
  });
  assert.equal(report.success, true);
  if (report.success) {
    assert.match(clientFaultLine(report.data), /^browser fault a1b2c3d4 \(events-stream\)/);
  }
});

test("a report without a session still names the fault", () => {
  const report = ClientFault.safeParse({ where: "events-stream", ref: "0f1e2d3c", message: "Malformed events frame payload" });
  assert.equal(report.success, true);
  if (report.success) {
    assert.equal(clientFaultLine(report.data), "browser fault 0f1e2d3c (events-stream): Malformed events frame payload");
  }
});

test("a ref that isn't the Notice's 8 hex characters is refused", () => {
  for (const bad of ["", "a1b2c3d", "a1b2c3d4e", "A1B2C3D4", "not-a-ref"]) {
    assert.equal(ClientFault.safeParse({ where: "events-stream", ref: bad, message: "x" }).success, false, bad);
  }
  // The log line is shaped on the server, not by whoever sent the report.
  assert.equal(ClientFault.safeParse({ where: "events-stream", ref: "a1b2c3d4", message: "x", issues: Array.from({ length: 21 }, () => ({})) }).success, false);
});
