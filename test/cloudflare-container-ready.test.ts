import assert from "node:assert/strict";
import { test } from "node:test";

import { isNotRunningError, mayBeContainerError, waitFor } from "../cloudflare/container-ready.ts";

// What @cloudflare/containers answers when the container stopped under a request.
const NOT_RUNNING = "Error proxying request to container: The container is not running, consider calling start()";

test("only a plain-text 500 is read to tell whether it's the Container class's error", () => {
  assert.equal(mayBeContainerError(new Response(NOT_RUNNING, { status: 500 })), true);
  assert.equal(mayBeContainerError(new Response(NOT_RUNNING, { status: 200 })), false);
  assert.equal(
    mayBeContainerError(new Response("<html></html>", { status: 500, headers: { "content-type": "text/html" } })),
    false,
  );
  assert.equal(
    mayBeContainerError(new Response("{}", { status: 500, headers: { "content-type": "application/json" } })),
    false,
  );
});

test("a request is sent again only when the container wasn't running for it", () => {
  assert.equal(isNotRunningError(NOT_RUNNING), true);
  // The request may have reached the app: sending it again could do it twice.
  assert.equal(isNotRunningError("Container suddenly disconnected, try again"), false);
  assert.equal(isNotRunningError("Error proxying request to container: Network connection lost."), false);
  // The app's own error that happens to say it.
  assert.equal(isNotRunningError("Internal error: the container is not running"), false);
});

test("waitFor resolves once the condition holds, or gives up after the timeout", async () => {
  let checks = 0;
  assert.equal(await waitFor(() => ++checks >= 3, 1000, 1), true);
  assert.equal(checks, 3);
  assert.equal(await waitFor(() => true, 0, 1), true);
  const started = Date.now();
  assert.equal(await waitFor(() => false, 30, 5), false);
  assert.ok(Date.now() - started >= 30);
});
