// Network-disabled test computer: only its runtime directory and inference
// socket are mounted. No controller files, credentials, Docker or network.
import http from "node:http";
import { chmodSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
function relay(target, req, res) {
  const upstream = http.request(
    { ...target, path: req.url, method: req.method, headers: req.headers },
    (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
}
http
  .createServer((req, res) =>
    relay({ socketPath: "/data/broker.sock" }, req, res),
  )
  .listen(3408, "127.0.0.1");
try {
  unlinkSync("/data/agent.sock");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
http
  .createServer((req, res) =>
    relay({ host: "127.0.0.1", port: 8080 }, req, res),
  )
  .listen("/data/agent.sock", () => chmodSync("/data/agent.sock", 0o600));
const child = spawn("/opt/runtime-agent", [], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: "8080" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
