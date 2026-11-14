---
title: PH News Workbench
emoji: 📰
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# PH News Workbench — Hugging Face Space (Docker)

An isolated, Vercel-independent deployment of the newsroom workbench: the full
Next.js 16 App Router app (pages **and** API Route Handlers — the backend lives
in the same process) running as one container on port 7860. Built as a copy of
`Datanerdbytes/ph-news-workbench` while the Vercel account is paused.

The YAML frontmatter above is what Hugging Face uses to build the Space —
keep it at the very top of this file (`sdk: docker`, `app_port: 7860`).

## How the stack runs in the container

| Concern | How it runs here |
| --- | --- |
| Web + API | Next.js standalone server (`node server.js`), port 7860, non-root uid 1000 |
| Database | External Neon Postgres via `DATABASE_URL` — nothing is stored on the container |
| Media staging | Pluggable driver — `blob` (Vercel Blob) / `s3` (R2, B2, …) / `hf` (private HF dataset repo) |
| Scheduled publishing | In-process scheduler sweeps due posts every 60s (auto-starts in production; set `DISABLE_LOCAL_SCHEDULER=1` to stop it) |
| Reel normalization | ffmpeg is baked into the image; enabled with `ENABLE_LOCAL_VIDEO_PROCESSING=1` |
| Video downloads | **Not available** — the yt-dlp download worker is a macOS launchd agent, not part of this image; `/downloads` keeps its explainer state |
| Cron (`cron.yml`) | Not present in this copy — the in-process scheduler replaces the external sweep |

## Deploy checklist

### 1. Create the Space

1. huggingface.co → **New Space** → name it (e.g. `ph-news-workbench`).
2. SDK: **Docker** → Blank template. License optional. Public or Private both
   work (Private Spaces still serve the app to logged-in visitors via the
   embedded viewer; for a phone-friendly public URL choose Public).
3. Settings → **Variables and secrets** is where every credential below goes
   (New secret, not variable, for anything sensitive). Secrets are injected at
   container start — no rebuild needed when you change them.

### 2. Prepare the database (important)

`DATABASE_URL` should point at its **own** Neon database (a Neon branch of the
prod database is ideal), *not* the same database the paused Vercel app uses.
Two long-running deployments on one database each run the publish scheduler
and would race each other for due posts. If you must share the database, set
`DISABLE_LOCAL_SCHEDULER=1` on one of them.

Migrations are already applied to the prod database; a **fresh** database
needs them — run from your laptop with the new `DATABASE_URL` exported, e.g.
`DATABASE_URL=postgres://… node migrate-scheduling.mjs` for each
`migrate-*.mjs` that matches the tables you use, then seed the owner:
`DATABASE_URL=postgres://… OWNER_EMAIL=… OWNER_PASSWORD=… node seed-owner.js`.

### 3. Add secrets

| Secret | Value / notes |
| --- | --- |
| `DATABASE_URL` | The copy's own Neon connection string (`?sslmode=require`) |
| `BETTER_AUTH_SECRET` | Long random string |
| `BETTER_AUTH_URL` | `https://<your-user>-<space-name>.hf.space` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Same URL as above (comma-separated if more) |
| `SIGNUP_INVITE_CODE` | Invite code for new accounts |
| `CRON_SECRET` | Random string (bearer for `/api/schedule/run`) |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | From the Meta app |
| `FACEBOOK_GRAPH_VERSION` | e.g. `v23.0` |
| `FACEBOOK_PAGE_ID` | Pin the default Page (same value as the local `.env.local`) |
| `FACEBOOK_REDIRECT_URI` | `https://<your-user>-<space-name>.hf.space/api/facebook/callback` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | YouTube OAuth client |
| `GOOGLE_REDIRECT_URI` | `https://<your-user>-<space-name>.hf.space/api/youtube/callback` |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok content-posting app |
| `TIKTOK_REDIRECT_URI` | `https://<your-user>-<space-name>.hf.space/api/tiktok/callback` |
| `NIM_API_KEY` (+ optional `NIM_*` caps/models) | NVIDIA NIM for AI features |
| `OPENAI_API_KEY` | Optional — AI image editing |
| `HF_API_KEY` | Optional — Video composer LLM fallback (AI feature, **not** storage) |
| `BLOB_READ_WRITE_TOKEN` | Only when staying on the `blob` storage driver |
| `HF_TOKEN` | Only for the `hf` storage driver |
| `ENABLE_LOCAL_VIDEO_PROCESSING` | `1` to enable server-side reel normalization (ffmpeg included) |

### 4. Update the OAuth callback URLs

Each provider only redirects to URLs registered in its developer app. Add the
Space URLs next to the existing localhost ones (don't delete those — the Mac
dev server still uses them):

- **Meta app** (Facebook Login → Settings): add
  `https://<your-user>-<space-name>.hf.space/api/facebook/callback`
- **Google Cloud** OAuth client: add the `/api/youtube/callback` URL
- **TikTok** developer app: add the `/api/tiktok/callback` URL

### 5. Push the repo

```bash
cd ~/ph-news-workbench-hf
git remote add hf https://huggingface.co/spaces/<your-username>/<space-name>
git push hf main
# first push asks for your HF username + an access token with "write" scope
# (create one at https://huggingface.co/settings/tokens)
```

The Space builds the Docker image (5–10 min, live logs on the Space page),
then serves the app at `https://<your-user>-<space-name>.hf.space`.

### 6. First-run verification

1. Sign in with the owner account (seeded in step 2, or your usual owner
   email/password against the new database).
2. **Staging**: pick a photo in the Photos composer and confirm the upload
   lands (this exercises the storage driver end-to-end).
3. **Publishing**: publish a test post to your own Page; confirm it appears
   and the staged copy is cleaned up.
4. **Scheduling**: schedule a post ~2 minutes out and watch the log tick
   (`Container logs` on the Space page shows `route:"scheduler"` lines).

### 7. Operational notes

- **Logs**: Space page → *Logs* → *Container*. Build issues appear under
  *Build*.
- **Restarts** apply new secrets without a rebuild; **Factory reboot**
  rebuilds the image (needed after changing the Dockerfile/ARGs).
- **Free-tier sleep**: a Space with no HTTP traffic for ~48h sleeps and the
  scheduler stops with it. A cheap keep-alive pinger (e.g. cron-job.org hitting
  `/login` every 30 min) keeps it awake — or upgrade the Space to sleepless
  hardware.
- **HTTPS**: the Space terminates TLS, so better-auth uses the `__Secure-`
  cookie prefix — already handled by `proxy.ts`.

## Storage drivers

Staging (browser → storage → publish route) supports three backends. The
client half is chosen at **build time** via `NEXT_PUBLIC_STORAGE_DRIVER`
(inlined into the bundle; HF Spaces can't inject build args, so switch by
editing the `ARG NEXT_PUBLIC_STORAGE_DRIVER=` line in the `Dockerfile` and
re-pushing). The server half falls back to the same value unless
`STORAGE_DRIVER` overrides it — keep both on the same driver.

| Driver | Needs | Browser upload | Server read/delete | Notes |
| --- | --- | --- | --- | --- |
| `blob` (default) | `BLOB_READ_WRITE_TOKEN` | Direct to Vercel Blob via `/api/blob` | Vercel Blob API | Works only while the Blob store stays reachable during the pause |
| `s3` | `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE` | Presigned PUT straight to the bucket (fast, 1 GB ok) | Plain GET on the public base | Recommended fallback. R2: endpoint `https://<accountid>.r2.cloudflarestorage.com`, region `auto`, public base `https://pub-<hash>.r2.dev`. Bucket needs public-read GET |
| `hf` | `HF_TOKEN` (or `HF_API_KEY`), `HF_STAGING_REPO` | Multipart POST through the app server | Tokened GET/DELETE on the dataset repo | Create the dataset repo first (e.g. `username/workbench-staging`, **Private**). Private repos need the token for reads, so `<img>` previews of staged files won't render — prefer `s3` for full fidelity |

Switching drivers later only affects *new* stagings — staged copies are
transient and gone after each publish, so nothing to migrate.

## Local Docker test

```bash
docker build -t workbench-hf .
docker run --rm -p 7860:7860 --env-file .env.local workbench-hf
# → http://localhost:7860
```

(`--env-file .env.local` passes your local secrets; nothing is baked into the
image.)

## App docs

The original app README (features, workspace model, API map) lives upstream:
`Datanerdbytes/ph-news-workbench`. `AGENTS.md` and `.env.example` in this copy
stay accurate for self-hosted runs; `download-worker.ts` is included but only
runs on a machine with yt-dlp + ffmpeg installed (macOS launchd agent via
`npm run worker:install`).
