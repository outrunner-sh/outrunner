# Desktop signup and browser onboarding

Sessions run in the cloud. The desktop app opens the system browser for account signup/sign-in and the existing agent/repository onboarding. It never inspects or installs a local CLI during this flow.

After finishing or skipping onboarding, a desktop-origin user sees **Open desktop app** and **Continue on web**. Returning users go straight to that choice. A normal web signup keeps its existing behavior. The chosen organization, repository and model survive either continuation.

## Authentication handoff

- The native shell generates a random state and PKCE verifier in memory. It opens `/auth/desktop/start` with the state, SHA-256 challenge and intended destination. The verifier stays in the app.
- A sealed, HttpOnly, SameSite=Lax cookie retains desktop context for one hour through Google/GitHub OAuth, email OTP, repository authorization and reloads. OAuth/OTP completes in the browser, so onboarding has a real browser session.
- Only an explicit **Open desktop app** click calls the same-origin, authenticated handoff endpoint. It generates a single-use Supabase magic-link token for the signed-in account without sending email. The result must name that exact user ID.
- The encrypted return ticket expires after 60 seconds and binds the token to the native challenge, state, app origin, selected organization and safe destination. `runtime://signin` opens the installed app; a loopback link on the existing port 47823 supports an already-running app when scheme registration is unavailable.
- The native shell accepts only the matching pending attempt and focuses its window. The waiting webview posts the ticket with its native verifier. Supabase consumes the token once and creates a separate desktop session; the browser's rotating refresh token is never copied. The account and current access allowlist are checked before continuation.
- **Continue on web** clears the desktop context and navigates within the browser. It does not issue a desktop login or invoke a native command.

Expired attempts ask the user to restart sign-in from the desktop app and retain the web option. Provider-linking flows retain their existing loopback OAuth path.

## Release and validation

Ship the native shell changes along with the web changes: the flow uses two new Tauri commands and their remote-origin permissions. The existing `runtime` scheme and loopback listener are reused; no additional Supabase redirect allowlist entry or database migration is needed. Server-side Supabase admin access and `CREDENTIALS_ENCRYPTION_KEY` are required, as for existing account administration and stored credentials.

Unit tests cover context/ticket integrity, expiry, PKCE/state/origin binding, destination safety, account matching, OTP replay handling and access revocation. Native tests cover correlation, duplicate and stale callbacks. Browser tests exercise the real onboarding components, final choices, retry/errors, web-only behavior and desktop waiting. Provider OAuth and a packaged macOS launch still require release-environment validation.
