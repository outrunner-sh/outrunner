# Codex personal accounts and the requested organization connection

Status: groundwork in draft PR #328; the organization connection is not implemented.
Provider documentation checked on 2026-10-29.

## Confirmed product requirement

An organization admin connects their **personal ChatGPT Plus/Pro account** once.
Authorized current Outrunner org members should then use that connection for
their own cloud sessions and new computers, without signing in individually.
Existing personal authentication choices, working sessions and API-key
authentication must remain available. Do not substitute a service account,
pay-as-you-go billing, or a per-computer-only connection for this requirement.

## Supported login versus account delegation

The [Codex authentication guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
documents `codex login --device-auth` for remote/headless machines. It also
documents protected auth-cache transfer and automatic refresh during CLI use.
This is a native CLI account login; it does not depend on registering a
third-party Sign in with ChatGPT client. A missing SIWC configuration is not
evidence that this native login is unavailable.

The [OpenAI account-sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)
distinguishes the account owner's use on multiple devices from other people's
use of that account. The [Terms of Use, Registration and access](https://openai.com/policies/terms-of-use/#registration-and-access)
prohibit both sharing credentials and making a personal account available to
other people.

The requested operation outside that published support boundary is **delegating
one person's Plus/Pro Codex identity and subscription to other Outrunner org
members**. A server retaining all tokens would avoid disclosing those tokens,
but would still make that personal account available to the other users.
This is a provider-support limitation; no technical claim is made that the
native CLI cannot cache or refresh credentials on a remote computer.

The separate [third-party plan-usage documentation](https://developers.openai.com/siwc/token-sharing-open-source)
describes user-bound grants for OSS/local clients and directs hosted
applications to a separate integration process. Identity-only website OAuth
and an OSS user's plan-usage grant are not documentation of the requested
cross-user delegation. No SIWC registration or exception to the personal
account-sharing policy is assumed here.

The missing prerequisite for the exact requested product behavior is a
provider agreement or supported grant explicitly allowing that hosted,
multi-user personal-subscription delegation. A successful device login alone
would not establish it. Do not solicit or copy a real personal credential to
test delegation while that prerequisite is unresolved.

## Implemented groundwork

- The runtime accepts a distinct `codex-access-token` credential and calls
  `codex login --with-access-token`, using stdin and an isolated Codex home.
  It is separate from personal browser/device login and from Platform API keys.
  Adding this primitive does not turn a Plus/Pro account into a service account.
- Capability checks refuse unsupported computers before delivering auth or
  restoring, with an upgrade where the provider supports one.
- Tests cover restart/restore, replacement/removal, credential isolation and
  error redaction. They use synthetic credentials, not a real provider account.
- Org credential reads use the existing membership resolver after the sealed
  read completes; tests cover two members, cross-org refusal and removal during
  the read. Existing admin-only management and project permissions still apply.
- No new stored authentication choice, organization Codex connection, personal
  credential sharing, or connection UI is enabled.

## Central lifecycle design if provider-supported delegation becomes available

Reuse `orgCaller({ admin: true })` for connection management, `memberRole` for
current membership, and existing project permissions for session eligibility.
Store one encrypted connection per org, with public status metadata separated
from credentials. Bind login attempts to the org, initiating admin, random
attempt ID, expiry and generation; recheck admin status when completing login.

Keep upstream credentials in a central vault. Runtime computers should use
scoped broker credentials. On every new upstream operation, the broker must
check current membership, project access and the connection generation so
member removal and disconnect stop future use without waiting for copied
upstream credentials to expire. Preserve explicit personal choices and
API-key priority; never silently substitute billing sources.

Serialize refresh for each upstream connection across server instances using
a durable lease and fencing generation. Atomically store replacement tokens,
expiry and version. A stale refresh or login completion must not resurrect a
disconnected connection or overwrite a newer reconnect. Define bounded retry,
reconnect-required status and crash recovery against the selected provider's
documented refresh contract; do not invent token endpoints or assume that
native CLI refresh and third-party SIWC refresh are interchangeable.

This lifecycle and its admin/member UX remain a design, not a claim of a
completed or provider-supported shared personal-account connection. Keep the
PR draft until the actual supported grant, lifecycle, UI and evidence exist.
