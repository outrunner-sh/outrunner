import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { paths, tick } from "../deploy/vm/tick.mjs";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("VM scheduler preserves the Worker's job set and authenticates each POST", async () => {
  const worker = readFileSync("cloudflare/worker.ts", "utf8");
  const workerPaths = [...worker.matchAll(/call\("(\/api\/[^\"]+)"/g)].map((match) => match[1]);
  assert.ok(workerPaths.length > 0);
  assert.deepEqual(new Set(paths), new Set(workerPaths));
  const received: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer vm-test-key");
    received.push(request.url!);
    response.end("ok");
  });
  try {
    const origin = await listen(server);
    const results = await tick("vm-test-key", origin);
    assert.deepEqual(new Set(received), new Set(workerPaths));
    assert.ok(results.every((result) => result.ok && result.status === 200));
  } finally {
    await close(server);
  }
});

test("VM scheduler isolates failed and timed-out jobs and never forwards credentials through a redirect", async () => {
  let forwarded = 0;
  const destination = createServer((_request, response) => {
    forwarded++;
    response.end("unexpected");
  });
  const received = new Set<string>();
  const redirect = await listen(destination);
  const server = createServer((request, response) => {
    received.add(request.url!);
    if (request.url === paths[0]) {
      response.writeHead(503).end("unavailable");
    } else if (request.url === paths[1]) {
      response.writeHead(307, { location: redirect }).end();
    } else if (request.url !== paths[2]) {
      response.end("ok");
    }
  });
  try {
    const origin = await listen(server);
    const results = await tick("vm-test-key", origin, 800);
    assert.equal(received.size, paths.length);
    assert.equal(results.filter((result) => result.ok).length, 3);
    assert.equal(results[0].status, 503);
    assert.equal(results[1].status, null);
    assert.equal(results[2].status, null);
    assert.equal(forwarded, 0);
    assert.equal(JSON.stringify(results).includes("vm-test-key"), false);
  } finally {
    await close(server);
    await close(destination);
  }
});

test("VM scheduler refuses an absent cron credential", async () => {
  await assert.rejects(tick(""), /BILLING_CRON_SECRET is required/);
});
