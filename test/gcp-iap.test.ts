import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { iapStream } from "@/lib/runtime/gcp/iap";
function frame(tag: number, data: Buffer) { const b = Buffer.alloc(6 + data.length); b.writeUInt16BE(tag); b.writeUInt32BE(data.length, 2); data.copy(b, 6); return b; }
async function server() {
  const http = createServer(); const wss = new WebSocketServer({ server: http, handleProtocols: () => "relay.tunnel.cloudproxy.app" });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  return { http, wss, url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/v4/connect`, close: async () => { for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve()))); } };
}
test("native IAP tunnels frame SSH bytes, acknowledge reads and authenticate without credentials in URLs", async () => {
  const s = await server(); let received = Buffer.alloc(0); let acknowledged = BigInt(0);
  s.wss.on("connection", (socket, request) => {
    const url = new URL(request.url!, "http://localhost"); assert.equal(url.searchParams.get("project"), "sandbox-project"); assert.equal(url.searchParams.get("port"), "22"); assert.equal(url.searchParams.get("instance"), "outrunner-vm"); assert.equal(request.headers.authorization, "Bearer temporary-token"); assert.equal(request.url!.includes("temporary-token"), false);
    socket.send(frame(1, Buffer.from("sid")));
    socket.on("message", (value) => {
      const b = value as Buffer; const tag = b.readUInt16BE(0);
      if (tag === 4) {
        assert.ok(b.length - 6 <= 16384); received = Buffer.concat([received, b.subarray(6)]);
        const ack = Buffer.alloc(10); ack.writeUInt16BE(7); ack.writeBigUInt64BE(BigInt(received.length), 2); socket.send(ack);
        if (received.length === 512 * 1024) socket.send(frame(4, Buffer.from("SSH-reply")));
      } else if (tag === 7) acknowledged = b.readBigUInt64BE(2);
    });
  });
  const stream = await iapStream({ project: "sandbox-project", zone: "us-central1-a", instance: "outrunner-vm" }, "temporary-token", s.url);
  try {
    const reply = once(stream, "data");
    await new Promise<void>((resolve, reject) => stream.write(Buffer.alloc(512 * 1024, 42), (err) => err ? reject(err) : resolve()));
    assert.equal((await reply)[0].toString(), "SSH-reply"); assert.equal(received.length, 512 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(acknowledged, BigInt(9));
  } finally { stream.destroy(); await s.close(); }
});
test("IAP fails closed on malformed handshakes", async () => {
  const s = await server(); s.wss.on("connection", (socket) => socket.send(Buffer.from([0, 1, 0])));
  try { await assert.rejects(iapStream({ project: "p", zone: "z", instance: "vm" }, "token", s.url), /invalid IAP/); } finally { await s.close(); }
});
test("IAP rejects forged acknowledgements and closes the SSH stream", async () => {
  const s = await server(); s.wss.on("connection", (socket) => { socket.send(frame(1, Buffer.from("sid"))); socket.on("message", () => { const b = Buffer.alloc(10); b.writeUInt16BE(7); b.writeBigUInt64BE(BigInt(999999), 2); socket.send(b); }); });
  const stream = await iapStream({ project: "p", zone: "z", instance: "vm" }, "token", s.url);
  try { const failed = once(stream, "error"); stream.write(Buffer.from("hi")); assert.match((await failed)[0].message, /invalid IAP/); } finally { stream.destroy(); await s.close(); }
});
