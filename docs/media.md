# Media: screenshots and recordings for pull requests

A session's agent proves a change a person can see by putting screenshots or a
GIF of it in its pull request. Outrunner hosts those files: the agent uploads a
file from its box and gets back a link that GitHub shows, and the line to paste,
`![name](url)`.

## How a file gets there

```
session's agent ──upload_media / outrunner media upload──▶ runtime-agent (on the box)
runtime-agent ──POST /api/runtime/media (signed)──▶ app: checks the session and org caps,
                                                    reserves a row, signs an upload URL
runtime-agent ──PUT bytes──▶ Supabase Storage, bucket `media`
runtime-agent ──POST /api/runtime/media/complete (signed)──▶ app: checks the stored size and
                                                             first bytes, makes the link live
```

- **Who can upload.** Only a box's runtime-agent. It signs each request with its
  `RUNTIME_AGENT_SECRET` and sandbox id, as it does when it asks for GitHub
  tokens (`lib/media/box-auth.ts`, `runtime-agent/internal/media`). The
  sessions' environment never has that secret. A session reaches the agent on
  the loopback with its own ask token, so it can only upload for itself. No
  user's API key or long-lived token is involved.
- **What.** PNG, JPEG, GIF, WebP and MP4, up to 50 MB. The type is read from the
  file's first bytes on the box and checked again on the stored object, so the
  app only ever serves an image or a video.
- **Caps per org.** 30 uploads a minute (in memory), 500 a day, and 10 GB kept
  (`lib/media/media.ts`). The daily and storage caps are checked under a lock
  per org in `reserve_media_upload`. An upload not finished within an hour is
  swept at the org's next upload.
- **Recorded.** Each row has the uploader (the session's owner), the session,
  the org, the size, the type and the time (`media` table).

## Links

- `/m/{publicId}.{ext}` is the file. `publicId` is 32 random bytes, so a link
  can't be guessed. The app streams the file from the private bucket and passes
  a range through so videos seek. It is served with `nosniff` and a sandboxing
  CSP.
- **Access.** An image's link is public by default. A video's link is private
  by default: it opens only for its uploader, signed in, and is a 404 for anyone
  else. Pass `access: "public"` to the upload to open it for anyone.
- **The owner's page.** `/media/{id}` shows the file, its link and markdown,
  and lets the uploader make it public or private, replace the link (a new
  `publicId`; every embed of the old one breaks, so this is never routine
  cleanup), or delete it. Nobody else can open the page.
- **The session's list.** The session's Environment panel lists what its agent
  uploaded, under Media.

## Setting it up

- Apply `supabase/migrations/20261103170000_media.sql`. It creates the `media`
  table, `reserve_media_upload`, and the private `media` bucket with a 50 MB
  limit and the five types.
- On hosted Supabase, the project's global upload limit (Storage → Settings)
  must be at least 50 MB. The free plan's maximum is 50 MB.
- `RUNTIME_BASE_URL` must be the app's public origin. Links are built from it,
  and a box only gets `OUTRUNNER_APP_URL` (how it reaches the app) when it is an
  `https://` URL.
