# The Outrunner GitHub App

Code review posts as a GitHub App (`outrunner[bot]`), not as whoever turned
review on. Each deployment registers its own app, because an app has one
webhook URL and one setup URL:

| Deployment | App name | Domain |
|---|---|---|
| Production | `outrunner` | `https://app.outrunner.sh` |
| Staging | `outrunner-staging` | the staging domain |

Without the four `GITHUB_APP_*` variables, the Automations page says the app
isn't set up, and the webhook answers 503.

## Register it

On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub
App**. Create it under the organization that should own it (for example
`neevai-labs`), not under a personal account.

- **GitHub App name**: `outrunner`, or `outrunner-staging`. Its URL name is
  the `GITHUB_APP_SLUG`.
- **Homepage URL**: the deployment's domain.
- **Callback URL**: leave it empty, and leave **Request user authorization
  (OAuth) during installation** off. Sign-in stays on the existing OAuth app.
- **Setup URL**: `https://<domain>/api/github/app/setup`. Turn on **Redirect
  on update**, so changing the app's repositories on GitHub comes back to
  Outrunner too.
- **Webhook**: turn it on.
  - **Webhook URL**: `https://<domain>/api/github/app/webhook`
  - **Webhook secret**: a long random string (`openssl rand -hex 32`). This is
    `GITHUB_APP_WEBHOOK_SECRET`.
- **Repository permissions**:
  - Pull requests: **Read and write**, to comment on them.
  - Contents: **Read-only**, to read the code under review.
  - Metadata: **Read-only**. GitHub requires it.
- **Subscribe to events**: **Pull request**. GitHub sends `installation` and
  `installation_repositories` events to every app without a subscription.
- **Where can this GitHub App be installed?**: **Any account**, so users can
  install it on their own organizations.

After you create it:

1. Note the **App ID** at the top of the app's page. This is `GITHUB_APP_ID`.
2. Under **Private keys**, choose **Generate a private key**. GitHub downloads
   a `.pem` file. Its contents are `GITHUB_APP_PRIVATE_KEY`. The app accepts
   the file as is, flattened to one line with literal `\n`s, or as base64 of
   the file.

Set the four values on the deployment (`deploy-cloudflare.md`, Code review) or
in `.env.local`.

## How it's used

1. In Outrunner, an org admin opens **Automations** in the sidebar and chooses
   **Install on GitHub**. Outrunner keeps the org in a short-lived cookie and
   sends the admin to the app's install page.
2. The admin picks the account and repositories on GitHub. GitHub sends them
   back to the setup URL, and Outrunner links the installation to that org
   (`lib/github/app-setup.ts`). It links only an installation the admin
   controls: one on their own GitHub account, or on an organization where
   they're an admin of one of the repositories it covers.
3. Uninstalling or suspending the app on GitHub, or changing its
   repositories, reaches the webhook, which updates the link
   (`lib/github/app-events.ts`).

Choosing which repositories get reviewed, and the review sessions
themselves, come next.

## Local development

GitHub can't reach `localhost`, so forward the webhook with a public relay:

```bash
npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/api/github/app/webhook
```

Point a separate development app's webhook URL at the smee channel, and its
setup URL at `http://localhost:3000/api/github/app/setup`. The setup URL is
opened by your browser, so `localhost` works there.
