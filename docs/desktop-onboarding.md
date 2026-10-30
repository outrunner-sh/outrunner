# Desktop onboarding

After signing into Outrunner, desktop users choose Claude Code or Codex and
whether to run on this Mac or in the cloud. The existing Google/GitHub system
browser sign-in and callback remain unchanged.

`liveEnv` checks native `local_status` alongside server credential metadata.
Detection never imports the CLI's credentials or automatically chooses an agent,
execution target, billing method or organization scope. Unknown login status is
shown as unknown and must be confirmed before onboarding completes.

## On this Mac

An installed, authenticated CLI is reused without another login. If necessary,
the app prepares the selected CLI and launches its normal browser sign-in. The
saved method is `local`. Users choose a local folder instead of connecting
GitHub. The agent, execution target and folder travel to the new-session form in
the URL, including when browser storage is unavailable. New local sessions are
enabled again; the native runtime check keeps web sessions in the cloud.

Claude uses the existing private managed installation. Codex uses a native
platform package from the official npm registry, pinned to the runtime's tested
version in `managed_codex.rs`. The archive's SHA-512 integrity is verified before
extraction, the native executable is checked, and its bundled companion tools
and resources are retained. It lives under `~/.outrunner/codex/<version>` and
does not change the user's shell PATH or install npm/Node. A working installed
version at least as new as the pin is preferred. Bump the pin with
`lib/runtime/box-image.ts`.

For a local Codex login, `local_codex_models` asks the CLI's app-server
`model/list` for models and capabilities. The model picker doesn't rely on an
unrelated cloud credential or invent account models when discovery fails.

## Cloud

The desktop can reuse effective personal/organization connections or explicitly
select another method. Claude subscription connection keeps its existing native
setup-token flow. API keys and Outrunner models remain available.

The desktop Codex card replaces the web's copy-and-run CLI instructions:

1. A same-origin, signed-in POST to `/api/settings/codex/desktop` starts an
   attempt through the existing connection manager. Personal scope is the
   default; organization scope is explicit and requires an admin.
2. The server returns an encrypted ten-minute capability bound to the actor,
   deployment origin, scope and attempt. It is not a general CLI or API token.
3. Native `connect_codex_start` prepares Codex and starts the bundled runtime
   helper `desktop-codex-auth`. The capability is passed over stdin, never argv.
4. The helper reuses the existing isolated `codex login --device-auth` flow.
   Only the allowlisted official approval URL and device code reach the UI. The
   native app opens the system browser. Provider tokens never cross the webview.
5. The helper sends the fresh login directly over HTTPS to
   `/api/desktop/codex`. The capability permits only checking, completing or
   canceling that exact attempt. Provider verification, current membership/admin
   checks, SQL attempt fences, encrypted storage, centralized refresh and
   runtime inference grants remain the existing connection manager's job.

Cancel, leaving the page or exiting the app closes the helper's stdin. The
helper cancels the provider process group and removes its temporary Codex home.
The server's cancellation/expiry/replacement checks reject late uploads. A failed
replacement leaves an existing connection intact. Desktop connection requires
the updated native app and controller, plus the existing Codex database
migration; it needs no separate npm CLI release. The browser keeps its existing
CLI-based connection path.

## Validation

The browser suite `desktop-onboarding.spec.ts` runs production components with
synthetic native/API boundaries: reuse, missing install, logged-out/unknown
login, first-session folder/target/model handoff, cloud approval and cancellation
at desktop and narrow window sizes. Go tests exercise actual child processes,
scoped HTTPS uploads and EOF cancellation with synthetic provider credentials.
TypeScript tests cover capability integrity/expiry/deployment binding, request
scope/actor/attempt restrictions, cancellation and progress recovery. Rust tests
cover the native URL boundary, catalog conversion and installer version pin.

Optional native download probe (no provider approval required):

```
cd runtime-desktop/src-tauri
cargo test --lib managed_codex::tests::downloads_and_runs -- --ignored
```

Live browser approval and a signed macOS application release are separate from
these checks. Do not report synthetic approval as a real provider connection.
