# Live Restream — implementation plan

Paste a public video URL (YouTube, Facebook, …) on the Live Page → preview it inline → broadcast it to the connected Facebook Page. The app resolves the link with yt-dlp (the same trick IINA uses) and an ffmpeg pump copies the resolved stream into the RTMPS ingest endpoint Facebook already returns to us.

Status: approved plan, build not started. This file is the single spec — subagents build against it.

## How it works (plain English)

- **yt-dlp** looks behind a public link and finds the real stream address hiding there.
- **Preview** plays that address in the browser — nothing is sent to Facebook yet.
- **Broadcast**: the Live Page asks Facebook for a live video (already built) and gets a send-here RTMPS address + secret key. A pump process runs `ffmpeg`, which copies the resolved stream into Facebook's address, non-stop. Facebook shows it as the Page's live video; viewers, comments and the existing comments panel work unchanged.

```
YouTube/Facebook URL
   ↓ yt-dlp resolves
real stream address (HLS/manifest or file)
   ↓ Preview: played on the Live Page
   ↓ Go live
ffmpeg pump ──▶ Facebook RTMPS address + stream key
                   ↓
        Page goes LIVE (comments flow back)
```

## What exists today (evidence)

| Piece | Where |
|---|---|
| Live Page UI (create/schedule/update/end streams, comments) | `app/live/page.tsx` |
| Graph API live video calls (`{pageId}/live_videos`, comments) | `lib/publishing/live.ts` |
| POST/GET/PATCH/DELETE `/api/live` routes; key stored encrypted | `app/api/live/route.ts`, `app/api/live/[id]/route.ts` |
| Stream key encryption | `lib/facebook-token.ts` (`encryptToken`/`decryptToken`) |
| URL→key split of the RTMPS ingest URL | `app/api/live/route.ts` `splitStreamUrl()` |
| ffmpeg + ffprobe spawn pattern | `lib/reels/media.ts` |
| Local-processing gate (`ENABLE_LOCAL_VIDEO_PROCESSING=1`) | `lib/reels/media.ts` `localRuntimeEnabled()` |
| yt-dlp usage + codec probe (`isSafariFriendly`) | `download-worker.ts` |
| ffmpeg already in the production image | `Dockerfile` (`apt-get install ffmpeg`); Render ships the CI-built image (`docs/deployment.md`) |
| DB schema for `live_streams` | `lib/schema.sql` |
| Migration pattern (root `migrate-*.mjs`, run by `scripts/prepare-e2e-db.mjs`) | root, 17 existing files |
| Post-migration column verification | `scripts/prepare-e2e-db.mjs` `requiredColumns` |

## Fixed contracts

Every agent builds against these exactly; changing one means updating this file first.

### Database — `migrate-live-restream.mjs` (root) + `lib/schema.sql`

```sql
ALTER TABLE live_streams
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS pump_status TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS pump_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pump_error TEXT;
```

Both files carry the columns: fresh installs via `lib/schema.sql`, existing DBs via the migration (idempotent `IF NOT EXISTS`). The four columns are added to `requiredColumns` in `scripts/prepare-e2e-db.mjs` so CI asserts them.

### API 1 — resolve

- `POST /api/live/resolve`, body `{ url: string }`
- `200` → `{ title, isLive, playableUrl, extractor }`
- `400` invalid URL · `502` upstream failure with a friendly message
- Runs `yt-dlp -J --no-playlist <url>` with a ~20s timeout; auth/bot-check failures map to a clear error, never raw stderr.

### API 2 — pump

- `POST /api/live/[id]/pump`, body `{ action: 'start' | 'stop' }`
- `start` requires `source_url` on the row and a decryptable stream key; spawns the pump; `409` when already running. `source_url` must hold a playable URL — the resolve response's `playableUrl`, saved when the source is attached or re-resolved immediately before spawning the pump. The pump never resolves a URL itself; for staged sources the feeders read this same playable source.
- `stop` kills the process and records `stopped`.
- Returns `{ pump: { status, startedAt } }`.
- Existing `GET /api/live` responses gain `sourceUrl`, `pumpStatus`, `pumpStartedAt`, `pumpError`. A row marked `running` in the DB with no live process (e.g. after a server restart) reports `interrupted`.

### `lib/live/resolve.ts`

- `resolveVideoUrl(url: string): Promise<ResolvedVideo>` → `{ title, isLive, playableUrl, extractor }`
- `ResolveError` codes: `invalid_url | unavailable | auth_required | unsupported | timeout | failed`
- Binary lookup order: `YTDLP_PATH` env → `yt-dlp` on PATH → (dev fallback) the venv pattern from `download-worker.ts`.
- URL is passed as a single argv element, never shell-interpolated.

### `lib/live/pump.ts`

- `buildPumpArgs({ source, dest, needsTranscode }): string[]` — copy path: `-re -i <source> -c copy -f flv <dest>` (+ reconnect flags for live HLS); transcode path: `libx264` + `aac` + `yuv420p`. `dest` is the stored `secure_stream_url` base with the decrypted key reassembled.
- `decideTranscode(probe: VideoStreams): boolean` — H.264/yuv420p with AAC/MP3/no-audio → copy; anything else (AV1, HEVC, …) → light re-encode. Reuses the codec logic from `download-worker.ts`.
- `PumpManager` singleton — `start` / `stop` / `status` per stream id; stderr watchdog; max 3 retries with backoff; **never logs the stream key** (redaction helper); refuses to spawn unless `localRuntimeEnabled()` is true.

### UI behavior (Live Page)

- Composer card gains a **Source URL** field + **Preview** button; resolved title auto-fills the stream title.
- Preview player: native HLS in Safari; `hls.js` (new dependency) for Chrome/Firefox.
- Stream cards with a source show **Go live** / **Stop** and a pump status chip (`running / idle / stopped / interrupted` with one-click restart).
- Rights hint: only stream content you own or have licensed.

## Subagent orchestration

Isolated worktrees per agent, merged sequentially into the feature branch. Feature branch: `restream/live-source-url` (rename of the existing `wt/main` in `/Users/roelsomido/ph-news-workbench-hf-wt`). Each agent commits on its own branch in its own worktree; after each stage the merge owner diffs into the feature worktree, runs `vitest` + `typecheck`, fixes or bounces the work, then starts the next stage.

Every agent brief includes: read `node_modules/next/dist/docs` first (this Next.js version differs from older ones — repo `AGENTS.md`), colocated unit tests are mandatory deliverables, no real processes/network in unit tests, no pushes.

| Stage | Agent | Files (disjoint unless noted) | Depends on |
|---|---|---|---|
| 1 · parallel | **A — resolver** | `lib/live/resolve.ts`, `lib/live/resolve.test.ts`, `app/api/live/resolve/route.ts`, Dockerfile (yt-dlp static binary) | — |
| 1 · parallel | **B — pump core** | `lib/live/pump.ts`, `lib/live/pump.test.ts` (pure logic; fake child processes) | — |
| 1 · parallel | **C — schema** | `migrate-live-restream.mjs`, `lib/schema.sql`, `scripts/prepare-e2e-db.mjs` (`requiredColumns`) | — |
| 2 | **D — pump API** | `app/api/live/[id]/pump/route.ts`, extend `GET /api/live` (`toStream` + columns), `lib/live/pump-state.ts`, `lib/live/pump-state.test.ts` | A? no — B, C merged |
| 3 | **E — UI** | `package.json` (+`hls.js`), `components/live/source-preview.tsx`, `components/live/source-preview.test.tsx`, `app/live/page.tsx`, `lib/live/preview-proxy.ts`, `lib/live/preview-proxy.test.ts`, `app/api/live/preview/route.ts`, `app/api/live/preview/route.test.ts` | A, D merged |
| 4 | **F — integration** | `e2e/live-restream.spec.ts`, README/docs, full gate run | all merged |

Shared-file safety: only C touches schema files; only D touches `app/api/live/route.ts`; only E touches `app/live/page.tsx`.

## Per-agent deliverables and test matrix

Conventions: vitest, colocated `*.test.ts(x)`, `vi.mock('node:child_process')`, fixtures as consts in the test file, every test name states input → expected output.

### Agent A — resolver

Files: `lib/live/resolve.ts`, `lib/live/resolve.test.ts`, `app/api/live/resolve/route.ts`, Dockerfile.

| Test (`lib/live/resolve.test.ts`) | Input | Expected output |
|---|---|---|
| rejects non-http URLs | `ftp://x`, `javascript:alert(1)`, `''` | `ResolveError` `invalid_url`; spawn never called |
| passes URL as argv, not shell | any URL | spawn called with args array, `shell: false`, URL is one argv element |
| parses live JSON | fixture mimicking `yt-dlp -J` for a live stream (`is_live: true`) | `{ title, isLive: true, playableUrl: <manifest>, extractor }` |
| parses VOD JSON | fixture with `is_live: false`, format URL | `{ isLive: false, playableUrl: <format url> }` |
| maps unavailable | exit 1, stderr "Video unavailable" | `ResolveError` `unavailable` |
| maps bot-check | stderr "Sign in to confirm you're not a bot" | `ResolveError` `auth_required` |
| maps timeout | process that never exits | `ResolveError` `timeout`, child killed |
| binary lookup order | `YTDLP_PATH=/custom/yt-dlp` set / unset | spawn uses the env path; unset falls back to `yt-dlp` on PATH |

### Agent B — pump core

Files: `lib/live/pump.ts`, `lib/live/pump.test.ts`.

| Test | Input | Expected output |
|---|---|---|
| args: copy path | probe `{videoCodec:'h264', pixelFormat:'yuv420p', audioCodec:'aac'}` | args contain `-re`, `-c copy`, `-f flv`, reconnect flags for live HLS, dest last; no `libx264` |
| args: transcode path | probe `videoCodec:'av1'` | args contain `libx264`, `aac`, `yuv420p`; no `-c copy` |
| transcode matrix | h264+aac → false · av1 → true · hevc → true · h264+mp3 → false · h264+null audio → false · null video → true | booleans as listed |
| retry policy | exit 1 mid-stream ×3 vs exit 0 vs fatal stderr | retries ≤ 3 with backoff, stops after limit, success ends cleanly |
| key secrecy | dest with key, forced error lines containing the key | every loggable string has the key replaced by `***` |
| state machine | fake `EventEmitter` child | start → `running`; exit(1) → retry scheduled; stop → SIGINT then SIGKILL after grace; double start rejected; empty manager → `interrupted` |
| gate off | production mode, gate env unset | `start()` refuses, no spawn |

### Agent C — schema

Files: `migrate-live-restream.mjs`, `lib/schema.sql`, `scripts/prepare-e2e-db.mjs`.

No unit test file — matches the 17 existing untested migrations. Verification instead:

1. Adds the four columns to `requiredColumns` in `prepare-e2e-db.mjs` → CI asserts them on every e2e run.
2. Runs the migration twice against local docker Postgres — second run exits 0.
3. Fresh-install (`schema.sql`) and migration paths yield identical columns — exercised by F's e2e provisioning.

### Agent D — pump API

Files: `app/api/live/[id]/pump/route.ts`, `app/api/live/route.ts` (GET fields), `lib/live/pump-state.ts`, `lib/live/pump-state.test.ts`.

| Test (`lib/live/pump-state.test.ts`) | Input | Expected output |
|---|---|---|
| ingest URL reassembly | base with/without trailing slash + key; null base | joined `rtmps://…/<key>`; slash inserted when missing; error on null base |
| status mapping | DB `running` + process alive → `running`; DB `running` + no process → `interrupted`; `stopped`, `idle` pass through | mapped values |
| action validation | `{action:'start'}` ok; `pause`, missing, array | guard error, route renders 400 |
| start guards | no `source_url` / undecryptable key / already running | each guard returns its 4xx error object; spawn never called |

### Agent E — UI

Files: `package.json`, `components/live/source-preview.tsx`, `components/live/source-preview.test.tsx`, `app/live/page.tsx`.

| Test | Input | Expected output |
|---|---|---|
| Safari path | fake `canPlayType` supporting HLS | `<video src>` rendered directly; hls.js import never called |
| Chrome path | no native HLS | mocked `hls.js` dynamic import called once; `loadSource`/`attach` invoked; `destroy` on unmount |
| error state | resolve API returns `auth_required` | friendly message + retry, no crash |
| pump controls | `pumpStatus: running / idle / interrupted` | Stop vs Go live shown accordingly; `interrupted` renders restart chip |
| guards | no resolved source / unavailable response | Go live disabled with hint; rights hint visible |

### Agent F — integration

Files: `e2e/live-restream.spec.ts`, README/docs updates. Deterministic, network-free paths only (e2e workspace already has a seeded Facebook connection):

| Test | Input | Expected output |
|---|---|---|
| resolve rejects bad URL | POST `/api/live/resolve` `{url:'not-a-url'}` | 400, `invalid_url`, no yt-dlp invoked |
| Live Page renders controls | visit `/live` | Source URL field, Preview button, rights hint visible |
| pump start without source | seeded stream lacking `source_url` → POST pump start | 4xx guard error; UI shows no crash |
| staged AV1-only source | resolve reports `staged`, no playable URL → POST pump start | pump start rejected; UI shows AV1-only video not supported for broadcast |
| fresh DB provisioning | full `prepare-e2e-db.mjs` run | exits `prepared: true`, new columns present |

Then runs the full gates: `lint`, `typecheck`, `vitest run`, image build — all green.

## Final live verification (human-in-the-loop, after Stage F)

1. Dev on :3000 (hf dev env). Paste a real public URL → preview plays.
2. Create the stream → RTMPS endpoint + key returned as today.
3. Go live → `ffmpeg` process verified running; Graph API reports the stream receiving video (`LIVE_NOW` with data flowing).
4. Comments panel polls while live.
5. End stream → pump stops, Facebook stream ends.
6. User manually tests; nothing is committed to the PR until confirmed.

## CI / delivery gate timeline

1. PR opens → automatic: lint, typecheck, unit tests, Docker build + Trivy scan, Playwright e2e (needs the `e2e` approval; Neon `ci-e2e` valid until 2026-11-21).
2. CodeRabbit review — blocking; respond per fix commit.
3. User approval → merge.
4. Merge → GitHub Actions drives the Render deploy (full commit sha, production branch rule).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Trivy flags the yt-dlp binary | pin a clean release or install via a slim Python stage |
| YouTube bot-check from datacenter IP | friendly error in v1; cookies-file secret is the documented fallback; Facebook links typically fine |
| Pump dies on deploy/restart (runs inside web service) | reports `interrupted` with one-click restart; dedicated Render background worker is the follow-up |
| Facebook ingest requires H.264/AAC | probe + transcode fallback built into pump core |
| Long VOD source ends early | `-re` realtime pacing; documented that a VOD broadcasts once through |

## Delta 2026-11-19 — DASH-only sources (Facebook replay VODs)

Found during live verification with a real Facebook replay URL: both the local
yt-dlp and the pinned 2026.10.26 binary return ONLY `http_dash_segments`
formats for such videos — no progressive file, no HLS manifest, no manifest
URL. Neither browser nor ffmpeg can consume fragment lists. Proven fix (local
PoC, ffmpeg exit 0): two yt-dlp feeder processes pipe video-only/audio-only
DASH into named FIFOs; ffmpeg copies them into the broadcast.

Contracts changed (this file remains the single spec):

- **API 1 — resolve**: the 200 response gains `mode: 'direct' | 'staged'`.
  `staged` means "no directly playable URL, but the pump can pipe it":
  `playableUrl` is `null`, `title`/`isLive`/`extractor` are still populated.
  `direct` is today's behavior with a playable URL. Errors unchanged.
- **lib/live/resolve.ts**: classifies staged when no progressive/HLS format
  AND no `manifest_url`/`url` exist. Also adds `--js-runtimes node` to every
  yt-dlp invocation (mirrors `download-worker.ts`; required for YouTube).
- **Database**: `live_streams` gains `source_mode TEXT` — the migration is
  unshipped, so `migrate-live-restream.mjs` grows the column instead of
  spawning a new migration; `lib/schema.sql` and `requiredColumns` match.
- **API 2 — pump**: `POST /api/live` persists `sourceMode` from the resolve
  response (NULL = legacy/direct). Pump start reads the row: `direct` keeps
  today's ffprobe → args path; `staged` skips ffprobe (pipes are
  unprobeable) and builds the feeder argv.
- **lib/live/pump.ts** staged mode: `mkfifo` pair under `os.tmpdir()`; two
  yt-dlp feeders (`-f bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/bv*`
  and `-f ba/b`, both with `--no-playlist --js-runtimes node -o -`) write the
  FIFOs; ffmpeg runs `-re -i <v.fifo> -i <a.fifo> -c:v copy -c:a aac -f flv
  <dest>`. Backpressure from `-re` paces the feeders. Feeder stderr joins the
  watchdog; any feeder death triggers the existing retry (a staged retry
  restarts the download from zero). FIFOs are unlinked on every exit path.
  A finished VOD EOFs into the existing clean-stop state machine (broadcasts
  once through). The feeders request H.264 video so it can be copied; if no H.264-compatible
  video exists (AV1-only or vp9-only sources), the pump rejects the source
  before broadcasting and the UI shows the rejection instead of an
  unplayable stream. AV1-only and vp9-only video are documented v1
  limitations. Audio is always transcoded to aac (handles opus/mp3 sources).
- **UI**: a staged resolve auto-fills the title and renders a neutral
  "Preview unavailable for this source — Go live streams it through the
  pump" card (no video element); create passes `mode` through with the URL.
  Direct sources unchanged.

## Delta 2026-11-19 (2) — CORS-safe live preview proxy

Verified against a real YouTube live: googlevideo manifest + segment responses
carry **no `Access-Control-Allow-Origin`** — hls.js (Chrome/Firefox) cannot
load them, so the inline preview failed with "Unable to play media". Native
HLS (Safari/WebKit) is unaffected, as is the pump (server-side fetch). Fix: a
signed-in streaming proxy so hls.js loads same-origin.

- **lib/live/preview-proxy.ts** (pure, unit-tested):
  `isHlsUrl(url)`; `rewritePlaylist(body, baseUrl)` — line-based rewriter that
  resolves every non-comment line and every `URI="…"` attribute
  (`EXT-X-KEY`/`EXT-X-MAP`/`EXT-X-MEDIA`/`EXT-X-I-FRAME-STREAM-INF`) against
  the playlist URL and rewrites it to `/api/live/preview?url=<encoded>`;
  `assertPublicUrl(url)` SSRF guard — http(s) only; resolves each hostname
  once and rejects the request if any resolved address is loopback, private,
  link-local, or unique-local. The connection uses a validated address while
  the original hostname is preserved for TLS SNI and the Host header.
- **app/api/live/preview/route.ts**: `GET /api/live/preview?url=…`, same
  signed-in guard as resolve. Validates the SSRF guard on the initial URL,
  re-validates it on every redirect hop (≤3), and applies it to every
  playlist or segment URL rewritten through the proxy; fetches with
  `redirect: 'manual'`, sniffs `#EXTM3U` → returns the rewritten playlist as
  `application/vnd.apple.mpegurl`; anything else streams the body through
  verbatim (never buffered to the heap). `cache-control: no-store`.
- **UI**: `SourcePreview` wraps HLS `playableUrl` with the proxy URL for both
  the native `src` and the hls.js `loadSource`; direct-file sources unchanged
  (cross-origin `<video>` playback needs no CORS).
- Tests: rewriting matrix (relative/absolute/attr URIs, keys/maps), SSRF
  rejections, route streaming passthrough, component proxy wiring.

## Open decisions (none blocking)

- v1 ships the pump inside the web service as planned; a separate Render background worker from day one is the alternative if long broadcasts are expected immediately.
