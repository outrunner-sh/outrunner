import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Cache Components: each page's static shell is prerendered and prefetched,
   * so a click shows it at once while anything read per request streams in
   * under its <Suspense>; and the last few pages visited stay alive, hidden in
   * React <Activity>, so going back to one shows it as it was. Pages export
   * `unstable_instant` where a click must never wait on the server: the build
   * fails if one would.
   */
  cacheComponents: true,

  // The Daytona SDK loads `form-data` lazily for file uploads. Turbopack
  // cannot transform that dynamic Node require, so leave both packages for
  // the Node runtime rather than bundling them into route handlers.
  // ssh2 (the Neev tunnel) loads optional native bindings the same way.
  serverExternalPackages: ["@daytonaio/sdk", "form-data", "ssh2"],

  // The Daytona provider reads the cross-compiled runtime-agent binary at
  // request time via `readFile(RUNTIME_AGENT_BINARY_PATH)` (upload-on-provision,
  // decision 1A). The path is computed at runtime, so Next's file tracer cannot
  // follow it — without this the binary is missing from the serverless bundle on
  // Vercel and provisioning throws "Cannot read runtime-agent binary". Force it
  // into every route that provisions a Runtime Computer (i.e. uploads the agent).
  // Delete this once the agent is baked into runtime-computer-v2.
  outputFileTracingIncludes: {
    "/api/projects/[id]/workspaces": ["./bin/runtime-agent-linux-amd64"],
    "/api/workspaces/[id]/session": ["./bin/runtime-agent-linux-amd64"],
    "/api/workspaces/[id]/lifecycle": ["./bin/runtime-agent-linux-amd64"],
  },

  /**
   * Dev-only: allow the sandbox preview tunnel host to request /_next dev
   * resources. Without this, Next.js blocks the cross-origin request and HMR
   * plus the dev error overlay stop working when the app is opened through the
   * preview tunnel rather than localhost.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.modal.host"],

  images: {
    // GitHub avatar served for the signed-in owner in the app shell.
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },

  experimental: {
    /**
     * Inline CSS into the document instead of emitting <link> tags.
     *
     * Required for the sandbox preview panel to render correctly. The preview
     * tunnel authenticates with a cookie marked `SameSite=Lax`, and the panel
     * embeds the tunnel in a cross-site iframe, so the cookie is not attached
     * to subresource requests: every `/_next/static/**` asset returns 401 and
     * the page renders as unstyled HTML. Inlining makes styles ride along with
     * the document, which carries the auth token in its URL and does load.
     *
     * Only takes effect in `next build` (it is a no-op in `next dev`), which is
     * why the sandbox run script builds and serves a production bundle.
     *
     * Tailwind is atomic and this app is small, so the payload cost is minor.
     */
    inlineCss: true,
  },
};

export default nextConfig;
