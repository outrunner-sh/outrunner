# Contributing to Outrunner

Bug fixes, documentation, and small improvements are welcome as pull requests.
For a new feature or a large refactor, open an issue first to discuss the use
case and approach. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## Set up a checkout

Fork the repository, branch from `main`, and follow the
[development guide](docs/development.md). You can run unit tests and the isolated
browser fixtures without an Outrunner account or production credentials.
Running the full app requires your own Supabase project; cloud sessions also
need a sandbox provider and agent credentials.

## Check your change

For the web app:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm check` runs typecheck, lint, and tests. Browser interaction changes should
also exercise the affected flow; `pnpm test:browser` covers the isolated fixtures.
See [test/browser/README.md](test/browser/README.md) for browser installation.
SQL integration tests skip when their test database variables are unset; the
[development guide](docs/development.md#database-tests) explains how to run them.

Check other components when you change them:

```sh
# Go agent and CLI
(cd runtime-agent && go build ./... && go vet ./... && go test ./...)

# Cloudflare worker (independent dependency tree)
(cd cloudflare && pnpm install --ignore-workspace --frozen-lockfile && pnpm check)
```

Desktop development and native checks require macOS and the toolchains described
in [runtime-desktop/README.md](runtime-desktop/README.md). For database changes,
add a new migration rather than editing an applied one, then run
[migration verification](supabase/README.md#verifying-the-schema) against a
throwaway database.

## Code and review

- Follow the conventions of nearby code. Use TypeScript's strict types and
  `gofmt` for Go; avoid unrelated formatting changes.
- Keep secrets in `.env.local` or a secret manager. Examples and test fixtures
  must use synthetic credentials and data.
- Preserve the agent protocol across TypeScript and Go. Update golden fixtures
  and both implementations when changing it.
- Add tests for changed behavior where they catch a meaningful regression.
  For a visible change, include a screenshot or short recording and describe
  the steps you verified. See [PR evidence](docs/pr-evidence.md).
- Keep pull requests focused. Explain the problem, the resulting behavior,
  checks run, and any limitations. Use a descriptive title such as
  `Sessions: preserve drafts when switching tabs`.
- If you use a coding agent, review its output and verify the change yourself.
  You are responsible for the contribution you submit.

By contributing, you agree that your contributions are licensed under this
repository's [MIT License](LICENSE). Preserve existing third-party license and
copyright notices.
