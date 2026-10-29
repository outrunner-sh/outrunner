These smoke tests run production components in a separate Next app under
`test/browser`. The real app gets no fixture routes or authentication bypass.
All API calls are intercepted by Playwright; no test creates a real session,
changes a project, or merges a pull request.

Run once to install Chromium:

```sh
pnpm exec playwright install chromium
```

Then run both desktop and mobile checks:

```sh
pnpm test:browser
```

Screenshots and failure traces are saved under `.context/`. You can use an
existing compatible Chromium with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
