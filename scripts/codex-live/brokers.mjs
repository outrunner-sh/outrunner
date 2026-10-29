// Host-side inference-only Unix relays. Computers have no network access.
import http from "node:http";
import { chmodSync, unlinkSync } from "node:fs";
import { root } from "./env.mjs";
for (const name of ["computer-a", "computer-b"]) {
  const socket = root + "/" + name + "/broker.sock";
  try {
    unlinkSync(socket);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  http
    .createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (
        ![
          "GET /api/runtime/codex/models",
          "POST /api/runtime/codex/responses",
          "POST /api/runtime/codex/responses/compact",
        ].includes(req.method + " " + url.pathname)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const query = new URLSearchParams();
      const version = url.searchParams.get("client_version");
      if (version && /^\d+\.\d+\.\d+$/.test(version))
        query.set("client_version", version);
      const upstream = http.request(
        "http://127.0.0.1:3408" +
          url.pathname +
          (query.size ? "?" + query : ""),
        {
          method: req.method,
          headers: { ...req.headers, host: "127.0.0.1:3408" },
        },
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
    })
    .listen(socket, () => chmodSync(socket, 0o600));
}
console.log("Inference-only test sockets ready. No TCP listener.");
