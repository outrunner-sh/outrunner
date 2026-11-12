import assert from "node:assert/strict";
import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { watchEventStream } from "@/lib/observability/streams";

/** A server whose handler is `answer`, each response watched; how many
 *  holds were let go of, and the streams open, are what it reports. */
async function serve(answer: (res: ServerResponse) => void) {
  const open = new Set<ServerResponse>();
  let released = 0;
  const server = createServer((_req, res) => {
    watchEventStream(res, () => released++, open);
    answer(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { open, released: () => released, port, close: () => server.close() };
}

function get(port: number): Promise<{ status: number; first: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", path: "/" }, (res) => {
      res.once("data", (chunk: Buffer) => {
        resolve({ status: res.statusCode ?? 0, first: chunk.toString() });
        req.destroy();
      });
    });
    req.on("error", () => {});
    req.once("error", reject);
    req.end();
  });
}

test("an event stream set by setHeader, then an implicit header, is let go of and kept open", async () => {
  const s = await serve((res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.write("data: hi\n\n");
  });
  assert.deepEqual(await get(s.port), { status: 200, first: "data: hi\n\n" });
  assert.equal(s.released(), 1);
  // The client went: no longer open.
  for (let i = 0; i < 100 && s.open.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.open.size, 0);
  s.close();
});

test("an event stream named in writeHead's headers, object or array, counts too", async () => {
  for (const headers of [{ "content-type": "text/event-stream" }, ["Content-Type", "text/event-stream"]]) {
    const s = await serve((res) => {
      res.writeHead(200, "OK", headers as never);
      res.write("data: x\n\n");
    });
    await get(s.port);
    assert.equal(s.released(), 1);
    s.close();
  }
});

test("destroying an open event stream, as shutdown() does, ends it for the client and drops it from the set", async () => {
  const s = await serve((res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: x\n\n");
  });
  // A client that stays connected until the server ends the stream.
  const ended = new Promise<void>((resolve) => {
    const req = request({ port: s.port, host: "127.0.0.1", path: "/" }, (res) => {
      res.resume();
      res.once("close", () => resolve());
    });
    req.on("error", () => resolve());
    req.end();
  });
  for (let i = 0; i < 100 && s.open.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.open.size, 1);
  for (const stream of s.open) stream.destroy();
  await ended;
  for (let i = 0; i < 100 && s.open.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.open.size, 0);
  s.close();
});

test("any other response keeps its hold until it ends", async () => {
  const s = await serve((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  assert.deepEqual(await get(s.port), { status: 200, first: "{}" });
  assert.equal(s.released(), 0);
  assert.equal(s.open.size, 0);
  s.close();
});
