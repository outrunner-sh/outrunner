# Release setup — Apple signing, notarization & auto-update

One-time setup to turn on signed, notarized, auto-updating releases of the
Outrunner desktop app. **Requires someone with access to the team's Apple
Developer account** (Account Holder or Admin — a plain member can't create the
certificate). The Apple Developer Program membership is already active.

Once these steps are done, releasing is just: bump the version and push a
`desktop-v*` tag. CI (`.github/workflows/release-desktop.yml`) does the rest.

---

## Step 1 — Developer ID Application certificate

This is the cert that lets the app be distributed as a DMG and open with no
Gatekeeper warning. (Pick **Developer ID Application**, *not* "Apple
Distribution" — the latter is Mac App Store only, which we don't use.)

- [ ] Keychain Access → Certificate Assistant → **Request a Certificate from a
      Certificate Authority** → "Saved to disk" → save the `.certSigningRequest`.
- [ ] developer.apple.com → Certificates, IDs & Profiles → Certificates → **+** →
      **Developer ID Application** → upload the CSR → download the `.cer`.
- [ ] Double-click the `.cer` to add it to Keychain (appears under "My
      Certificates", with a private key under the disclosure triangle).
- [ ] In Keychain, select the certificate **together with its private key** →
      right-click → **Export 2 items…** → save as `cert.p12` → set a password.
      *Remember this password — it becomes `APPLE_CERTIFICATE_PASSWORD`.*
- [ ] Capture the identity string:
      ```bash
      security find-identity -v -p codesigning
      ```
      Copy the line `Developer ID Application: <Team Name> (TEAMID)` — it becomes
      `APPLE_SIGNING_IDENTITY`.

## Step 2 — App Store Connect API key (for notarization)

- [ ] App Store Connect → Users and Access → **Integrations → App Store Connect
      API** → **+** (role: **Developer** or **App Manager**).
- [ ] Download `AuthKey_XXXXXXXXXX.p8` — **you only get one chance**.
- [ ] Note the **Key ID** (10 chars) and the **Issuer ID** (UUID) shown on that
      page. These become `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.

## Step 3 — Updater signing key

Signs the auto-update artifacts; the public half is verified by every installed
app.

- [ ] Generate the key pair:
      ```bash
      cd runtime-desktop && pnpm install && pnpm tauri signing generate
      ```
- [ ] Paste the printed **public key** into `src-tauri/tauri.conf.json`, replacing
      `PASTE_TAURI_UPDATER_PUBLIC_KEY_HERE`, and commit that change.
- [ ] Keep the **private key** and the password you set — they become
      `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Step 4 — GitHub repo secrets

Base64-encode the two binary files first:

```bash
base64 -i cert.p12                 # → APPLE_CERTIFICATE
base64 -i AuthKey_XXXXXXXXXX.p8     # → APPLE_API_KEY_P8
```

Then add all 8 under **repo → Settings → Secrets and variables → Actions**
(names must match exactly):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of `cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password (Step 1) |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Team> (TEAMID)` (Step 1) |
| `APPLE_API_ISSUER` | Issuer ID (Step 2) |
| `APPLE_API_KEY_ID` | Key ID (Step 2) |
| `APPLE_API_KEY_P8` | base64 of the `.p8` (Step 2) |
| `TAURI_SIGNING_PRIVATE_KEY` | updater private key (Step 3) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password, or `""` if none (Step 3) |

## Step 5 — Cut the first release

- [ ] Set `version` in `src-tauri/tauri.conf.json` (e.g. `0.1.0`).
- [ ] Tag and push — the tag must match that version or CI fails fast:
      ```bash
      git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
      ```
- [ ] Watch the **Release desktop app** workflow. It builds the universal binary,
      signs, notarizes, runs the verification gate (codesign / spctl / stapler /
      `latest.json`), and publishes the DMG + `latest.json` to a GitHub Release.

## Step 6 — Manual smoke check (per release)

CI can't prove end-user behaviour, so verify once by hand (also in `INSTALL.md`):

- [ ] On a Mac that's never seen the app, download the DMG **through a browser or
      Slack** (so it gets the quarantine flag a real download gets); confirm it
      opens with **no** Gatekeeper warning and **no** `xattr` step.
- [ ] One real update hop: with version N installed, publish N+1, relaunch N, and
      confirm it self-updates.

---

### Notes / gotchas

- The Developer ID cert **private key must be exported with the cert** (Export 2
  items). Exporting the cert alone yields a `.p12` CI can't sign with.
- Certificate renewals: the cert is valid ~5 years; regenerate and re-upload the
  `APPLE_CERTIFICATE`/`APPLE_SIGNING_IDENTITY` secrets when it expires.
- API-key notarization doesn't rot when a teammate leaves and needs no 2FA —
  that's why we use it over an Apple ID + app-specific password.
