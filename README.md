# PH News Workbench — self-hosted Docker deployment

[![CI](https://github.com/Datanerdbytes/ph-news-workbench-render/actions/workflows/ci.yml/badge.svg)](https://github.com/Datanerdbytes/ph-news-workbench-render/actions/workflows/ci.yml)

An isolated, Vercel-independent deployment of the newsroom workbench: the full
Next.js 16 App Router app (pages **and** API Route Handlers — the backend lives
in the same process) running as one container. Built as a copy of
`Datanerdbytes/ph-news-workbench` while the Vercel account is paused.

**Hosted on Render (free tier)** as a Docker web service. A Hugging Face Space
version of this exact setup is ready too — HF now gates Docker Spaces behind
PRO — the Dockerfile, storage drivers, and docs here work unchanged on either.

## How a change reaches production

```
pull request  ──►  CI (lint · types · tests · image build + scan · Playwright)
                     +  CodeRabbit review (advisory)  ──►  approval  ──►  merge
                                                                          │
  main push  ──►  CI again  ──►  Render deploy  ──►  health check  ──►  live
```

GitHub Actions is the only thing that deploys. A pull request never reaches
production, and a merge reaches it only after the same CI run is green. The
deploy job waits for Render to report the deploy **live** and then checks the
health endpoint, so a broken build fails the workflow instead of quietly
leaving the previous version running.

Full pipeline, required secrets, troubleshooting and rollback:
[`docs/deployment.md`](docs/deployment.md).

## How the stack runs in the container

| Concern | How it runs here |
| --- | --- |
| Web + API | Next.js standalone server (`node server.js`), binds `0.0.0.0:$PORT`, non-root uid 1000 |
| Database | External Neon Postgres via `DATABASE_URL` — nothing is stored on the container |
| Media staging | Pluggable driver — `blob` (Vercel Blob) / `s3` (R2, B2, …) / `hf` (private HF dataset repo) |
| Scheduled publishing | In-process scheduler sweeps due posts every 60s (auto-starts in production; set `DISABLE_LOCAL_SCHEDULER=1` to stop it) |
| Reel normalization | ffmpeg is baked into the image; enabled with `ENABLE_LOCAL_VIDEO_PROCESSING=1` |
| Keep-alive | `.github/workflows/keep-alive.yml` pings `/login` every 10 min so the free tier doesn't sleep — scheduled posts would stall while asleep |
| Live restream | yt-dlp (pinned static binary) + ffmpeg baked into the image; the pump spawns only when `ENABLE_LOCAL_VIDEO_PROCESSING=1` (dev runtimes are always allowed) — see [Live Restream](#live-restream) |
| Video downloads | **Not available** — the yt-dlp download worker is a macOS launchd agent, not part of this image (the pinned binary in the image serves the live restream resolver only); `/downloads` keeps its explainer state |

## Deploy checklist (Render)

This is the one-off setup for a **new** service. The existing service is
deployed by GitHub Actions — see [`docs/deployment.md`](docs/deployment.md)
for that pipeline, the required secrets and the rollback path.

1. **Repo**: this repo must be visible to Render — sign in at render.com with
   GitHub and install the Render GitHub App on it.
2. **New → Web Service** → pick this repo → runtime **Docker** → plan **Free**
   → region closest to you → **Create**. Or create it through the
   [Render API](https://api.render.com) with an API key (what this deploy
   used). `PORT` must be set (`10000` matches Render's default forward).
3. **Environment** — every secret below goes in Service → Environment:
   `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the
   `*.onrender.com` URL), `BETTER_AUTH_TRUSTED_ORIGINS` (same), `CRON_SECRET`,
   `SIGNUP_INVITE_CODE`, `NIM_API_KEY` (+ optional `NIM_*` caps),
   `OPENAI_API_KEY`, `FACEBOOK_APP_ID/SECRET`, `FACEBOOK_GRAPH_VERSION`,
   `FACEBOOK_PAGE_ID`, `FACEBOOK_REDIRECT_URI`
   (`https://<service>.onrender.com/api/facebook/callback`),
   `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI` (`…/api/youtube/callback`),
   `TIKTOK_CLIENT_KEY/SECRET`, `TIKTOK_REDIRECT_URI` (`…/api/tiktok/callback`),
   `BLOB_READ_WRITE_TOKEN`, optional `HF_API_KEY` (AI features),
   `ENABLE_LOCAL_VIDEO_PROCESSING=1`.
4. **OAuth callbacks**: add the `*.onrender.com` callback URLs in the Meta app,
   Google Cloud OAuth client, and TikTok developer app (keep the localhost
   ones for the Mac dev server).
5. **Health check**: set to `/login` (200 without a session) so deploys are
   judged correctly.

### Database warning

`DATABASE_URL` should point at its **own** Neon database (a Neon branch of
prod is ideal). Two long-running deployments on one database each run the
publish scheduler and would race each other for due posts — if you must share,
set `DISABLE_LOCAL_SCHEDULER=1` on one of them. A fresh database needs the
`migrate-*.mjs` scripts run and `seed-owner.js` for the owner account.

## Storage drivers

Staging (browser → storage → publish route) supports three backends. The
client half is chosen at **build time** via `NEXT_PUBLIC_STORAGE_DRIVER`
(inlined into the bundle; pass it as a Docker build arg). The server half
falls back to the same value unless `STORAGE_DRIVER` overrides it — keep both
on the same driver.

| Driver | Needs | Browser upload | Server read/delete | Notes |
| --- | --- | --- | --- | --- |
| `blob` (default) | `BLOB_READ_WRITE_TOKEN` | Direct to Vercel Blob via `/api/blob` | Vercel Blob API | Verified still reachable during the Vercel pause |
| `s3` | `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE` | Presigned PUT straight to the bucket (fast, 1 GB ok) | Plain GET on the public base | Recommended fallback. R2: endpoint `https://<accountid>.r2.cloudflarestorage.com`, region `auto`, public base `https://pub-<hash>.r2.dev`. Bucket needs public-read GET |
| `hf` | `HF_TOKEN` (or `HF_API_KEY`), `HF_STAGING_REPO` | Multipart POST through the app server | Tokened GET/DELETE on the dataset repo | Private dataset repo. Tokened reads mean `<img>` previews of staged files won't render — prefer `s3` for full fidelity |

Switching drivers later only affects *new* stagings — staged copies are
transient and gone after each publish, so nothing to migrate.

## Live Restream

The Live Page can broadcast a public video to the connected Facebook Page
without an encoder:

1. Paste a public video URL (YouTube, Facebook, …) into the **Source URL**
   field and press **Preview** — the server resolves the link with yt-dlp
   (`POST /api/live/resolve`) and the stream behind it plays inline on the
   page. Nothing is sent to Facebook yet.
2. Create the stream — Facebook returns the usual RTMPS server URL and
   stream key, as it does for encoder-based streams.
3. Press **Go live** — an ffmpeg pump on the server copies the resolved
   stream into Facebook's RTMPS ingest (`POST /api/live/<id>/pump`), non-stop.
   The Page goes live; viewers and the comments panel work unchanged.

Requirements and caveats:

- The production image carries the pinned yt-dlp static binary (downloaded
  per architecture — amd64 on Render, arm64 for a local Apple-silicon build —
  from the release pinned in `YTDLP_VERSION`) and ffmpeg. The pump only runs
  when `ENABLE_LOCAL_VIDEO_PROCESSING=1`; dev runtimes are always allowed.
- **Only stream content you own or have licensed** — the Live Page shows the
  same hint next to the Source URL field.
- A VOD source broadcasts once through: when the file ends, the pump stops.
  Live sources (HLS) get reconnect flags and retry with backoff. Replay VODs
  that expose only DASH fragments (typical Facebook replays) have no playable
  URL to preview — resolve marks them `staged`, the preview shows a neutral
  notice instead of a player, and **Go live** broadcasts them once through
  the pump piping (two yt-dlp feeders feeding ffmpeg), restarting any retry
  from the beginning.
- The pump runs inside the web service, so a deploy or restart kills it. A
  stream whose pump died that way reports **interrupted** on its card with a
  one-click restart; a dedicated background worker is the follow-up.

### Media runner worker (Fly.io)

> Not currently in use. The live app's runner runs on a Mac (next section);
> the Fly app was destroyed. This path remains as the alternative for a host
> that has to be cloud-side — note that Fly's trial plan stops machines every
> 5 minutes, so it needs a payment method to hold a broadcast.

The verified isolation runner needs OS namespaces to sandbox yt-dlp/ffmpeg.
Render refuses them, so the sandboxed work can live on a small companion
service instead: `media-runner.ts` (deployed via `Dockerfile.worker` +
`fly.worker.toml` on Fly.io, whose Firecracker VMs permit the namespaces).
The web app proxies to it over HTTPS with a shared bearer token whenever
`MEDIA_RUNNER_URL` is set:

- `POST /resolve` — the sandboxed yt-dlp link resolution (the Preview step).
- `POST /pump/start` / `POST /pump/stop` — the live pump, including the
  stream-key decryption and the Facebook ingest allowlist.
- The worker owns every `live_streams.pump_status` write in this mode and
  reconciles crashed pumps back into the DB within ~3s; a worker restart
  marks orphaned `running` rows `failed` at boot.

Setup:

```bash
# Secrets on the worker (DATABASE_URL + BETTER_AUTH_SECRET are the same
# values the web app uses; MEDIA_RUNNER_TOKEN is shared with the web app):
fly secrets set -a ph-news-media-runner DATABASE_URL=... BETTER_AUTH_SECRET=... MEDIA_RUNNER_TOKEN=...
# Deploy:
fly deploy -c fly.worker.toml -a ph-news-media-runner
# Web app env (Render): MEDIA_RUNNER_URL=https://ph-news-media-runner.fly.dev
#                       MEDIA_RUNNER_TOKEN=<same token>
```

Without `MEDIA_RUNNER_URL` the web app behaves exactly as before (in-process
pump + resolver on any runtime where the sandbox passes — local dev, for
instance). With it set, production gets full Resolve and Go live through the
worker while the web service itself stays sandbox-free.

### Media runner on a Mac (Tailscale Funnel)

The same `media-runner.ts` can run on a Mac instead of Fly.io. macOS passes
the sandbox's namespace probes, so no container is needed; the only missing
piece is a public URL, which Tailscale Funnel provides (free, no card, stable
`https://<machine>.<tailnet>.ts.net` hostname).

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:3e7548f3c5adc11426e2fe8f25ec73a14ddef2e42efeaaf3051096fbe2a3f8c1 -->

Create `.env.runner` in the repository root with the production Neon
`DATABASE_URL`, `BETTER_AUTH_SECRET`, and `MEDIA_RUNNER_TOKEN` used by the
deployed app.

```bash
brew install tailscale python         # one-time
./scripts/start-runner.sh             # tailscaled + funnel + runner under caffeinate
./scripts/start-runner.sh stop        # tear everything down
# Render env: MEDIA_RUNNER_URL=https://<machine>.<tailnet>.ts.net
```

One-time tailnet setup: `tailscale up` (browser login), enable **Funnel** for
the node, and enable **HTTPS Certificates** under the admin DNS page — Funnel
cannot issue its cert without that toggle.

Operational notes:

- The Mac must be awake and online for the whole broadcast. The script wraps
  the runner in `caffeinate -i -s`; closing the lid still suspends it.

<!-- /coderabbit-ai-generated:v1 -->
- `tailscaled` runs in userspace mode (no root, no TUN device). It must be
  started with `--statedir` or `tailscale cert` fails with `no
  TailscaleVarRoot`.
- The runner reads `.env.runner`, so local dev keeps using `.env.local` and
  the Docker Postgres — the two never collide.
- Funnel's first request after idle can take ~30s (DERP cold path); later
  calls are sub-second.

## Local Docker test

```bash
docker build -t workbench-selfhost .
docker run --rm -p 7860:7860 --env-file .env.local workbench-selfhost
# → http://localhost:7860
```

(`--env-file .env.local` passes your local secrets; nothing is baked into the
image.)

## Tests

`npm test` runs the Vitest suite.

`npm run test:e2e` is the CI form: it expects the cloud E2E database that CI
provisions, because `e2e/helpers/db.ts` talks to Postgres through the Neon HTTP
driver. Against the local Docker stack use `npm run test:e2e:local` instead —
it preloads `scripts/neon-local.mjs` so the harness's driver calls tunnel
through `phnews-wsproxy` to `phnews-pg`, the same way the app does. Without the
preload those specs fail with `NeonDbError: … TypeError: fetch failed`.

The local form **writes to the database in `DATABASE_URL`** — the specs seed
notifications, flip drafts, and delete rows by fixture marker — so it refuses
to start unless that URL resolves to a local host (`scripts/require-local-db.mjs`).
That is a locality check, not an identity check: an SSH tunnel forwarding a
remote database to `localhost:5432` would still pass. And it is not a
disposable database, unlike CI's branch — expect your dev data to be touched.

## Notes

- The GitHub Actions keep-alive cron auto-disables after 60 days without a
  commit to this repo — re-enable it from the Actions tab if that happens.
- Free-tier trade-offs: 15-min idle spin-down (mitigated by the keep-alive),
  512 MB RAM (large reel uploads may be tight), ~1 min cold start after sleep.
- The original app README (features, workspace model, API map) lives upstream
  in `Datanerdbytes/ph-news-workbench`. `download-worker.ts` is included but
  only runs on a machine with yt-dlp + ffmpeg (macOS launchd agent via
  `npm run worker:install`).
