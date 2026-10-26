import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { previewablePort, PROVIDER_PORTS } from "@/lib/runtime/box-ports";

const fixtures = JSON.parse(readFileSync(path.join(process.cwd(), "lib/runtime/agent-protocol.fixtures.json"), "utf8"));

test("the provider's ports are the ones the agent leaves out", () => {
  assert.deepEqual([...PROVIDER_PORTS].sort(), [...fixtures.ProviderPorts[0]].sort());
});

test("a preview link is only for a server of the user's", () => {
  for (const port of [3000, 5173, 8443, 65535]) assert.equal(previewablePort(port), true, String(port));
  // The agent's, the provider's daemon (2280 runs processes), privileged, nonsense.
  for (const port of [8080, 2280, 22220, 22222, 33333, 22, 80, 1023, 65536, 3000.5, Number.NaN]) {
    assert.equal(previewablePort(port), false, String(port));
  }
});
