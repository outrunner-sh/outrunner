// AgentClient's control fetch over a mounted Unix socket; the real HTTP agent
// verifies its normal Runtime token after the computer's local TCP relay.
import http from "node:http";
export const unixFetch =
  (socketPath) =>
  (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(input);
      const req = http.request(
        {
          socketPath,
          path: url.pathname + url.search,
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: Object.fromEntries(
                  Object.entries(res.headers)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
                ),
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      if (init.body) req.write(init.body);
      req.end();
    });
