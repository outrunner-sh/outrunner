import assert from "node:assert/strict";
import { test } from "node:test";

import { ClientFault, clientFaultLine, CLIENT_FAULT_MESSAGES } from "@/lib/http/client-error-report";

const MALFORMED = CLIENT_FAULT_MESSAGES[0];
const SCHEMA_MISMATCH = CLIENT_FAULT_MESSAGES[1];

test("a fault report is accepted with its ref, session, and structural detail", () => {
  const report = ClientFault.safeParse({
    where: "events-stream",
    ref: "a1b2c3d4",
    message: SCHEMA_MISMATCH,
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
  const report = ClientFault.safeParse({ where: "events-stream", ref: "0f1e2d3c", message: MALFORMED });
  assert.equal(report.success, true);
  if (report.success) {
    assert.equal(clientFaultLine(report.data), `browser fault 0f1e2d3c (events-stream): ${MALFORMED}`);
  }
});

test("a ref that isn't the Notice's 8 hex characters is refused", () => {
  for (const bad of ["", "a1b2c3d", "a1b2c3d4e", "A1B2C3D4", "not-a-ref"]) {
    assert.equal(ClientFault.safeParse({ where: "events-stream", ref: bad, message: MALFORMED }).success, false, bad);
  }
  // The log line is shaped on the server, not by whoever sent the report.
  assert.equal(
    ClientFault.safeParse({
      where: "events-stream",
      ref: "a1b2c3d4",
      message: MALFORMED,
      issues: Array.from({ length: 21 }, () => ({ code: "invalid_type", path: [], message: "Expected" })),
    }).success,
    false,
  );
});

test("only the stream's own messages, from the stream's own place, are accepted", () => {
  assert.equal(ClientFault.safeParse({ where: "events-stream", ref: "a1b2c3d4", message: "Anything else" }).success, false);
  assert.equal(ClientFault.safeParse({ where: "settings", ref: "a1b2c3d4", message: MALFORMED }).success, false);
});

test("a field holding a line break cannot forge the log's next line", () => {
  assert.equal(
    ClientFault.safeParse({
      where: "events-stream",
      ref: "a1b2c3d4",
      message: SCHEMA_MISMATCH,
      eventId: "8\nERROR forged line",
      eventType: "usage\nERROR forged line",
      issues: [{ code: "invalid_type", path: ["content"], message: "Expected array\nERROR forged line" }],
    }).success,
    false,
  );
});

test("a path deeper than any Zod path is refused", () => {
  const path = (n: number) => ({ code: "invalid_type", path: Array.from({ length: n }, () => "a"), message: "Expected" });
  const report = (n: number) =>
    ClientFault.safeParse({
      where: "events-stream",
      ref: "a1b2c3d4",
      message: SCHEMA_MISMATCH,
      issues: [path(n)],
    });
  assert.equal(report(16).success, true);
  assert.equal(report(17).success, false);
});

test("issues carry only what identifies the shape, never a payload value", () => {
  const report = ClientFault.safeParse({
    where: "events-stream",
    ref: "a1b2c3d4",
    message: SCHEMA_MISMATCH,
    issues: [{ code: "invalid_type", path: ["items", 2, "t"], message: "Expected string", received: "a secret prompt" }],
  });
  assert.equal(report.success, true);
  if (report.success) {
    assert.deepEqual(report.data.issues, [{ code: "invalid_type", path: ["items", 2, "t"], message: "Expected string" }]);
  }
});
