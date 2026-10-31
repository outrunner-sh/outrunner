import { Duplex } from "node:stream";
import WebSocket from "ws";

/** IAP's relay.tunnel.cloudproxy.app v4 framing (the same transport as gcloud
 * start-iap-tunnel). A broken transport closes SSH; the next request creates a
 * fresh authenticated connection, never replays a partially executed command. */
export function iapStream(target: { project: string; zone: string; instance: string }, token: string, endpoint = "wss://tunnel.cloudproxy.app/v4/connect"): Promise<Duplex> {
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries({ ...target, interface: "nic0", port: "22", newWebsocket: "True" })) url.searchParams.set(k, v);
  const ws = new WebSocket(url, "relay.tunnel.cloudproxy.app", { headers: { authorization: `Bearer ${token}`, origin: "bot:iap-tunneling" }, perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: 20_000 });
  return new Promise((resolve, reject) => {
    let ready = false;
    let received = BigInt(0);
    let sent = BigInt(0);
    let acknowledged = BigInt(0);
    let write: { data: Buffer; offset: number; done: (error?: Error | null) => void } | null = null;
    const timeout = setTimeout(() => stream.destroy(new Error("IAP could not reach the VM's SSH port. Check IAP permissions and its firewall rule.")), 25_000);
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 25_000);
    ping.unref();
    const flush = () => {
      while (ready && write && sent - acknowledged < BigInt(256 * 1024) && ws.readyState === WebSocket.OPEN) {
        const chunk = write.data.subarray(write.offset, write.offset + 16384);
        const frame = Buffer.alloc(6 + chunk.length);
        frame.writeUInt16BE(4); frame.writeUInt32BE(chunk.length, 2); chunk.copy(frame, 6);
        sent += BigInt(chunk.length); write.offset += chunk.length;
        ws.send(frame, (error) => { if (error) stream.destroy(new Error("IAP could not send SSH data.")); });
        if (write.offset === write.data.length) { const done = write.done; write = null; done(); }
      }
    };
    const stream = new Duplex({
      read() { ws.resume(); },
      write(data: Buffer, _encoding, done) {
        if (!data.length) return done();
        write = { data, offset: 0, done }; flush();
      },
      destroy(error, done) {
        clearTimeout(timeout); clearInterval(ping);
        if (!ready) reject(error ?? new Error("IAP connection closed before SSH was ready."));
        if (write) { const callback = write.done; write = null; callback(error ?? new Error("IAP connection closed.")); }
        ws.terminate(); done(error);
      },
    });
    // Consumers attach an error handler after the promise resolves; an early
    // transport failure is delivered through its rejection instead.
    stream.on("error", () => {});
    ws.on("error", () => stream.destroy(new Error("IAP tunnel failed. Check Google Cloud access and network connectivity.")));
    ws.on("unexpected-response", (_req, response) => { response.resume(); stream.destroy(new Error(`IAP rejected the tunnel (HTTP ${response.statusCode}). Check the service account's IAP access.`)); });
    ws.on("close", () => stream.destroy(new Error("IAP tunnel disconnected.")));
    ws.on("message", (data, binary) => {
      try {
        if (!binary || !Buffer.isBuffer(data) || data.length < 2) throw new Error("Invalid IAP frame.");
        const tag = data.readUInt16BE(0);
        if (tag === 1) {
          if (ready || data.length < 6 || data.readUInt32BE(2) !== data.length - 6) throw new Error("Invalid IAP handshake.");
          ready = true; clearTimeout(timeout); resolve(stream); flush();
        } else if (tag === 4) {
          if (!ready || data.length < 6 || data.readUInt32BE(2) !== data.length - 6) throw new Error("Invalid IAP data.");
          received += BigInt(data.length - 6);
          const ack = Buffer.alloc(10); ack.writeUInt16BE(7); ack.writeBigUInt64BE(received, 2); ws.send(ack);
          if (!stream.push(data.subarray(6))) ws.pause();
        } else if (tag === 7) {
          if (!ready || data.length !== 10) throw new Error("Invalid IAP acknowledgement.");
          const ack = data.readBigUInt64BE(2);
          if (ack < acknowledged || ack > sent) throw new Error("Invalid IAP acknowledgement sequence.");
          acknowledged = ack; flush();
        } else throw new Error("Unsupported IAP frame.");
      } catch { stream.destroy(new Error("Google Cloud sent an invalid IAP tunnel frame.")); }
    });
  });
}
