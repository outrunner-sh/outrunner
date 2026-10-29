import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { env, root, systemEnv } from "./env.mjs";
const state = JSON.parse(readFileSync(root + "/state.json", "utf8"));
const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const app = "http://127.0.0.1:3408";
let login = null,
  verification = {
    running: false,
    checks: [],
    message: "Awaiting owner approval.",
  };
const origin = () =>
  JSON.parse(readFileSync(root + "/preview.json", "utf8")).origin;
const json = (res, data, status = 200) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
const check = ({ data, error }) => {
  if (error) throw new Error("Isolated database operation failed");
  return data;
};
const access = () => JSON.parse(readFileSync(root + "/access.json", "utf8"));
const same = (a, b) => {
  const x = Buffer.from(a ?? ""),
    y = Buffer.from(b ?? "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const html = String.raw`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Codex #328 live approval</title><style>body{font:16px system-ui;max-width:800px;margin:48px auto;padding:24px;line-height:1.55;color:#ddd;background:#101214}button,a{font:inherit;color:inherit}button{padding:10px 16px;margin:8px;border:1px solid #565c66;border-radius:8px;background:#252b33;cursor:pointer}a{color:#9bd6ff}section{padding:18px;border:1px solid #39414c;border-radius:12px;margin:18px 0}code,pre{white-space:pre-wrap;word-break:break-word}small{color:#afb7c3}</style><h1>Codex #328 · isolated live check</h1><p>This private launcher uses the branch-built Outrunner app, migrated disposable Supabase database, CLI and native runtime. It does not change production.</p><section><h2>1. Review the real settings</h2><p>Open the app as the isolated organization administrator. Use Back to return here. No connection or provider token exists yet.</p><button id="session">Open real Codex settings</button><button id="member">View teammate settings</button></section><section><h2>2. Approve your ChatGPT account</h2><p>Start the branch CLI here, then open the official OpenAI link and enter its device code. This authorizes this isolated organization to use the connected account for its current test members. Existing personal logins on your own computer are untouched.</p><button id="start">Start official device login</button><button id="cancel">Cancel sign-in</button><p id="login">Not started.</p><a id="approve" target="_blank" rel="noopener noreferrer" hidden>Approve on OpenAI</a><pre id="code"></pre><small>Device codes expire after 10 minutes. Start again if needed. If OpenAI asks, enable device-code login in ChatGPT security settings.</small></section><section><h2>3. Run live checks</h2><p>After the settings show Connected, this runs native inference as two test members, one central OAuth renewal, inference after renewal, organization isolation and member-removal checks. It uses a few short subscription turns.</p><button id="verify">Run inference and refresh checks</button><pre id="result"></pre></section><section><h2>4. Disconnect and clear</h2><p>Disconnect in real settings or use the button below. Future broker use stops immediately; an already-running provider request can finish. This clears encrypted provider credentials and test runtime sessions. Local CLI login files are removed on exit/cancel. Server logs never include provider credentials.</p><button id="disconnect">Disconnect and clear test sessions</button><p>After handoff, the agent will remove the isolated database and encryption key. For provider-side revocation, use your ChatGPT account's security controls; this test does not revoke unrelated existing logins.</p></section><p id="error" role="alert"></p><script>
const el=id=>document.getElementById(id);
async function unlock(){const token=new URLSearchParams(location.hash.slice(1)).get('access');if(token){history.replaceState(null,'','/__test');const r=await fetch('/__test/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(!r.ok)el('error').textContent='The private launcher link expired or was already used. Ask the agent for a fresh link.';}}
const unlocked=unlock();async function action(name){el('error').textContent='';try{await unlocked;const r=await fetch('/__test/'+name,{method:'POST'}),v=await r.json();if(!r.ok)throw Error(v.error);if(name==='session'||name==='member')window.location.assign('/settings/providers?tab=codex');return v;}catch(e){el('error').textContent=e.message;}}
for(const name of ['session','member','start','cancel','verify','disconnect'])el(name).onclick=()=>action(name);
async function poll(){try{await unlocked;const response=await fetch('/__test/status');if(!response.ok)throw Error('Locked');const v=await response.json();el('login').textContent=v.login?.message??'Not started.';el('approve').hidden=!v.login?.url;if(v.login?.url)el('approve').href=v.login.url;el('code').textContent=v.login?.code??'';el('result').textContent=(v.verification.checks??[]).join('\n')+'\n'+v.verification.message;}catch{el('login').textContent='Locked. Open the private single-use test link supplied by the agent.';}setTimeout(poll,1500);}poll();</script></html>`;
async function signIn(res, req, user = state.owner) {
  const secure = req.headers.origin?.startsWith("https://") ? "; Secure" : "";
  const link = check(
    await db.auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    }),
  );
  const cookies = [];
  const client = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => [],
        setAll: (values) => cookies.push(...values),
      },
    },
  );
  const auth = await client.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "email",
  });
  if (auth.error || auth.data.user?.id !== user.id)
    throw new Error("Could not sign in isolated admin");
  const headers = cookies.map(
    ({ name, value, options }) =>
      name +
      "=" +
      encodeURIComponent(value) +
      "; Path=/; SameSite=Lax; HttpOnly" +
      secure +
      (options.maxAge ? "; Max-Age=" + options.maxAge : ""),
  );
  headers.push(
    "outrunner_org=" + state.org + "; Path=/; SameSite=Lax; HttpOnly" + secure,
  );
  res.setHeader("Set-Cookie", headers);
  json(res, { ok: true });
}
function cancel() {
  if (login?.child) {
    login.child.kill("SIGINT");
    login.message =
      "Canceling sign-in; temporary provider files will be removed.";
  }
}
function start() {
  if (login?.child) throw new Error("A sign-in is already running");
  const current = (login = {
    message: "Starting branch CLI…",
    url: null,
    code: null,
    child: null,
  });
  const child = spawn(
    root + "/outrunner",
    [
      "--url",
      app,
      "--account",
      state.owner.id,
      "codex-auth",
      "--org",
      state.org,
    ],
    {
      env: { ...systemEnv, OUTRUNNER_CONFIG: root + "/cli.json" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  current.child = child;
  let text = "";
  function consume(data) {
    text += data.toString();
    if (text.length > 32768) text = text.slice(-16384);
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (
        /^https:\/\/auth\.openai\.com\/(?:codex\/)?device(?:auth)?(?:\/[A-Za-z0-9/_-]*)?$/.test(
          s,
        )
      ) {
        current.url = s;
        current.message = "Waiting for your browser approval.";
      }
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/.test(s)) current.code = s;
    }
  }
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.on("exit", (code) => {
    current.child = null;
    current.url = null;
    current.code = null;
    current.message =
      code === 0
        ? "Connected. Check real settings; live checks are ready."
        : "Sign-in canceled, expired or failed. Start again; no provider login is retained by the CLI.";
  });
}
function verify() {
  if (verification.running) throw new Error("Checks are already running");
  verification = { running: true, checks: [], message: "Running checks…" };
  const child = spawn(
    "node",
    [
      "--experimental-transform-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      root + "/app/scripts/codex-live/next-loader.mjs",
      "--import",
      "./scripts/test-loader.mjs",
      root + "/app/scripts/codex-live/verify.mjs",
    ],
    { cwd: root + "/app", env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "";
  child.stdout.on("data", (data) => {
    pending += data.toString();
    for (;;) {
      const n = pending.indexOf("\n");
      if (n < 0) break;
      const line = pending.slice(0, n);
      pending = pending.slice(n + 1);
      if (/^PASS |^FAIL |^INFO /.test(line))
        verification.checks.push(line.slice(0, 300));
    }
  });
  child.stderr.on("data", () => {});
  child.on("exit", (code) => {
    verification.running = false;
    verification.message =
      code === 0
        ? "All live checks passed. Disconnect and clear when finished."
        : "Checks did not complete; the agent will investigate the exact failed operation. No credential values are displayed.";
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (
        req.headers.origin !== origin() &&
        req.headers.origin !== "http://127.0.0.1:3410"
      ) {
        json(res, { error: "Invalid origin" }, 403);
        return;
      }
    }
    if (path === "/__test" || path === "/__test/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(html);
      return;
    }
    if (path === "/__test/unlock" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1024) {
          json(res, { error: "Too large" }, 413);
          return;
        }
      }
      const token = JSON.parse(raw).token;
      const ticket = access();
      if (
        typeof token !== "string" ||
        !ticket.hash ||
        Date.now() >= ticket.expires ||
        !same(createHash("sha256").update(token).digest("hex"), ticket.hash)
      ) {
        json(res, { error: "Expired or used test link" }, 403);
        return;
      }
      ticket.hash = null;
      writeFileSync(root + "/access.json", JSON.stringify(ticket), {
        mode: 0o600,
      });
      const secure = req.headers.origin?.startsWith("https://")
        ? "; Secure"
        : "";
      res.setHeader(
        "Set-Cookie",
        "codex_live_test=" +
          ticket.session +
          "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400" +
          secure,
      );
      json(res, { ok: true });
      return;
    }
    const ticket = access();
    const session = (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("codex_live_test="))
      ?.slice("codex_live_test=".length);
    if (Date.now() >= ticket.expires || !same(session, ticket.session)) {
      json(res, { error: "Open the private single-use test link first." }, 403);
      return;
    }
    if (path === "/__test/status" && req.method === "GET") {
      json(res, {
        login: login
          ? { message: login.message, url: login.url, code: login.code }
          : null,
        verification,
      });
      return;
    }
    if (path.startsWith("/__test/")) {
      if (req.method !== "POST") {
        json(res, { error: "POST required" }, 405);
        return;
      }
      if (path === "/__test/session") {
        await signIn(res, req);
        return;
      }
      if (path === "/__test/member") {
        await signIn(res, req, state.member);
        return;
      }
      if (path === "/__test/start") start();
      else if (path === "/__test/cancel") cancel();
      else if (path === "/__test/verify") verify();
      else if (path === "/__test/disconnect") {
        cancel();
        const cli = JSON.parse(readFileSync(root + "/cli.json", "utf8"));
        const removed = await fetch(app + "/api/cli/codex?org=" + state.org, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + cli.token },
        });
        if (!removed.ok)
          throw new Error("Could not disconnect through the real controller");
        const child = spawn(
          "node",
          [
            "--experimental-transform-types",
            "--import",
            root + "/app/scripts/codex-live/next-loader.mjs",
            "--import",
            "./scripts/test-loader.mjs",
            root + "/app/scripts/codex-live/verify.mjs",
            "--cleanup",
            "--check-revoked",
          ],
          { cwd: root + "/app", env, stdio: "ignore" },
        );
        child.on("error", () => {});
      } else {
        json(res, { error: "Not found" }, 404);
        return;
      }
      json(res, { ok: true });
      return;
    }
    // This protected development reverse proxy verifies browser writes against
    // its preview origin, then translates Origin/Host to the loopback app origin.
    // The shipping app still executes its own auth, role and CSRF checks.
    const headers = { ...req.headers, host: "127.0.0.1:3408" };
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    if (req.headers.origin) headers.origin = app;
    const upstream = http.request(
      app + req.url,
      { method: req.method, headers },
      (incoming) => {
        const out = { ...incoming.headers };
        if (out.location?.startsWith(app))
          out.location = origin() + out.location.slice(app.length);
        res.writeHead(incoming.statusCode, out);
        incoming.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) json(res, { error: "Branch app unavailable" }, 503);
      else res.destroy();
    });
    req.pipe(upstream);
    req.on("aborted", () => upstream.destroy());
  } catch {
    json(
      res,
      {
        error:
          "Isolated test operation failed; ask the agent to inspect the operation status.",
      },
      500,
    );
  }
});
server.listen(3410, "0.0.0.0", () =>
  console.log(
    "Protected test gateway ready on 3410 (create authenticated preview only).",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    cancel();
    server.close(() => process.exit());
  });
