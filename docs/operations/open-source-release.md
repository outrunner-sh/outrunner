# Open-source release

This is a maintainer guide for publishing the source repository and distributing
builds. Contributor setup is in [development](../development.md).

## Source and history

- Confirm that Outrunner, Inc., the copyright holder named in `LICENSE`, has
  authorized MIT distribution of the code being published, including earlier
  contributions.
- Review tracked files **and Git history** for credentials, personal data,
  internal transcripts, and files that cannot be redistributed. A deletion in
  the latest commit does not remove earlier copies. Rotate any confirmed
  exposed credential before deciding whether history needs rewriting.
- Keep the root `LICENSE`, [third-party notices](../../THIRD_PARTY_NOTICES.md),
  upstream notices in `licenses/`, and the font's OFL notice in distributions.
  Check transitive dependency terms for the artifacts being shipped.
- Run the checks in [CONTRIBUTING.md](../../CONTRIBUTING.md), including the
  production build and native checks on suitable machines. Explain any skips.

## GitHub settings

When making the repository public, enable private vulnerability reporting,
secret scanning and push protection, and dependency alerts where available.
The security policy provides an email fallback while private reporting is not
available. Configure branch protection or rulesets to require CI and review.

Changing repository visibility is a separate maintainer action. Public source
and a public license do not make hosted service credentials or deployment
access public.

## Forks and deployments

CI and cloud box checks use standard GitHub-hosted Linux runners. They require
no production credentials. Container publication, npm publication, production
deployment, desktop signing and downloads, and mirroring are upstream-only
maintainer workflows. A fork can adapt those repository guards to publish its
own artifacts after configuring its own accounts and secrets.

`cloudflare/wrangler.jsonc` describes the official hosted deployment, including
public Supabase values. Those values are intentionally public, but they are
not defaults for a fork: replace the account, domains, and Supabase project
before deploying. Keep service-role, encryption, signing, and provider keys
in secret stores.

For a desktop fork, replace the identifier, deep-link scheme, hosted-site
release default, updater endpoint, updater verification key, and matching
capabilities. Use your own signing identity and update infrastructure. For npm,
choose package names you control and update the launcher's platform map and
optional dependencies together.

## Existing databases

Apply schema changes before deploying code that requires them. Installations
from before the migration-version cleanup must follow the
[November 14 migration reconciliation](../../supabase/README.md#upgrading-past-the-november-14-migration-collision)
before applying pending migrations. Never rewrite a live database's migration
history just to make its version list match a fresh install.
