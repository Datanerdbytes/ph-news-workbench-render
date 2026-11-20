# Downloads fix — handover

Everything below is in the **Render repo only** (`Datanerdbytes/ph-news-workbench-render`).
The Vercel checkout (`/Users/roelsomido/ph-news-workbench`) was **not** modified.

- Written: 2026-11-19
- Repo: `git@github.com:Datanerdbytes/ph-news-workbench-render.git`
- Main checkout: `/Users/roelsomido/ph-news-workbench-hf` — `main` @ `0b238b0`
- Working branch (kept as a safety copy): `work/agent-prep` @ `0b238b0`
- Side worktree (disposable, see *Housekeeping*): `/Users/roelsomido/ph-news-workbench-hf-rd`
- **Nothing has been pushed.** `main` is 2 commits ahead of `origin/main` (`ad2add6`).

---

## 1. The bug

> "when I'm downloading a video there are two videos that always get downloaded"

Two independent defects, both confirmed against live data:

### 1a. Two files on disk → two rows in the list

Facebook serves **AV1**, which Safari cannot decode, so the worker re-encodes the
download to H.264 before uploading it. The converted rendition was written **next
to** the source and the source was never deleted:

```
…/VideoDownloader/Facebook/58382597-…/
  …[1467404582012159].mp4          ← AV1 source (7 941 734 B)
  …[1467404582012159] (H.264).mp4  ← rendition  (7 653 279 B)
```

`lib/downloads/disk-jobs.ts` reported **every** video file in a job folder, and
`app/api/downloads/route.ts` deduplicated cloud-vs-disk by *exact path*
(`job.saveLocation === disk.filePath`). The DB row points at the **rendition**, so
the source failed the match and surfaced as a second row → one download, two
entries.

### 1b. Orphan blobs in the cloud library

The blob path was `downloads/{workspace}/{job}/{video title}.mp4`, and the Facebook
title carries the **live view count**:

```
…/d66446e8-…/4.3K_views_…_1348129294001162.mp4
…/d66446e8-…/48K_views_…_1348129294001162.mp4
…/d66446e8-…/49K_views_…_1348129294001162_H.264.mp4
…/d66446e8-…/50K_views_…_1348129294001162.mp4
```

`allowOverwrite: true` only replaces a file with the **exact same path**, so every
retry landed under a new name and the older copies piled up (4 blobs for one job).
`DELETE /api/downloads/[id]` only removed the single `blob_url` the row recorded, so
the rest stayed forever.

> Why the blob key was **not** made anonymous: the Vercel Blob CDN derives the
> attachment filename from the stored pathname. Probed live —
> `?download=Custom_Name.mp4` is ignored (only `?download=1` works), and
> `Content-Disposition` always names the stored path. A job-id-style key would
> have shipped every download as `video.mp4`. The name stays; the siblings go.

---

## 2. The fix

### Commit `7111009` — "Downloads: keep one video per download"

| File | Change |
|---|---|
| `download-worker.ts` | New `removeSupersededSource(sourcePath, renditionPath)` — deletes the pre-conversion source **after the upload succeeds** (a failed upload must keep the original as fallback). Never throws. |
| `lib/downloads/disk-jobs.ts` | New `SAFARI_RENDITION_SUFFIX = " (H.264)"`, `isSafariRendition()`, `preferredJobFile()`. `discoverDiskDownloads()` now reports **one** file per job folder (rendition preferred, else the source). |
| `app/api/downloads/route.ts` | New `jobFolderFor(saveLocation)`. The cloud/disk merge deduplicates by **job folder**, not exact path. |

### Commit `0b238b0` — "Downloads: keep one blob per download job"

| File | Change |
|---|---|
| `download-worker.ts` | New `blobJobPrefix(workspaceId, jobId)`, `removeSupersededBlobs(prefix, keepUrl)` (lists the job folder, deletes everything but the file just uploaded, paginated, never throws) and `uploadJobVideo(prefix, filePath, fileName)` which uploads **and** prunes. A failed job also clears its folder, so an upload that landed before the failure does not stay behind. |
| `lib/storage.ts` | New `deleteStagedBlobsInFolder(urls)` — lists the store folder of a recorded URL and deletes all of it; falls back to deleting the recorded file if the folder cannot be listed. Only the blob driver can list a folder; the s3/hf drivers keep their previous behaviour. |
| `lib/blob.ts` | Re-exports `deleteStagedBlobsInFolder`. |
| `app/api/downloads/[id]/route.ts` | `DELETE` now clears the job's **whole folder** instead of only the recorded `blob_url`. |

### Behaviour, before → after

| | before | after |
|---|---|---|
| Files in a converted job folder | 2 (source + rendition) | **1** (rendition) |
| Rows in the downloads list per job | 2 | **1** |
| Blobs per job in the store | up to 4 after retries | **1** (older ones pruned) |
| Deleting a job | removed 1 blob | removes **the whole folder** |

---

## 3. Verification

Test-first throughout: failing test → confirm red for the right reason → implement → green.

- `download-worker.blobs.test.ts` (new, 5 cases) — keeps the uploaded file and deletes
  the superseded ones; deletes the whole folder when nothing should be kept; walks every
  page; never throws when the store cannot be listed; `uploadJobVideo` uploads into the
  job folder and prunes.
- `download-worker.convert.test.ts` (+3 cases) — removes the source once the rendition
  exists; keeps it when the conversion fails; keeps it so a failed upload can fall back.
- `lib/downloads/disk-jobs.test.ts` (+2 cases) — one file per job folder, rendition
  preferred; falls back to the source when there is no rendition.
- `app/api/downloads/route.test.ts` (+1 case) — one row for a folder holding both files.
- `lib/storage.test.ts` (+3 cases) — folder delete, fallback when listing fails, no-op
  without urls.
- `app/api/downloads/[id]/route.test.ts` (+1 case, 1 updated) — deleting a job removes
  every blob it left behind.

**Suite:** 115 files, **1054 passed / 1 skipped**. `tsc --noEmit` clean, `eslint` clean.
The pre-commit hook (eslint --fix → typecheck → full vitest) passed on both commits.

**Live checks against the real Vercel Blob store and the real DB:**

1. Store self-test — two uploads with different titles into one job folder
   → **1 blob left**, folder empty after cleanup.
2. End-to-end download (real Facebook video, AV1 source, job `068ee232-…`):
   - job folder on disk: **1 file** (`… [1467404582012159] (H.264).mp4`)
   - store: **1 blob** for the job, matching the row's `blob_url` and size (7 653 279 B)
   - DB row: `status=done`, `attempts=1` (no retry → no siblings were ever created)
   - the test job, its blob and its local file were deleted afterwards
3. The 4 orphaned blobs of job `d66446e8-…` were deleted (its DB row was already
   gone and its local folder had already been removed, so nothing referenced them).
   `downloads/` in the store is now empty.

---

## 4. Your Mac — the download worker

The worker is a **local companion**: it claims queued `download_jobs` rows from the
shared Neon DB, runs yt-dlp on this Mac, and uploads the result to Vercel Blob.
Render never runs it (`Dockerfile` → `CMD ["node","server.js"]`).

| What | Where |
|---|---|
| LaunchAgent | `~/Library/LaunchAgents/com.ph-news-workbench.download-worker.plist` |
| Backup of the original plist | `~/Library/LaunchAgents/com.ph-news-workbench.download-worker.plist.bak` |
| Worker code it runs | `/Users/roelsomido/ph-news-workbench-hf/download-worker.ts` (Render main checkout) |
| Worker env | `~/.config/ph-news-workbench/download-worker.env` (mode 600) |
| Log | `~/Library/Logs/ph-news-workbench-download-worker.log` |
| Node | `/usr/local/bin/node` (v24.22.1) |

The env file holds exactly two keys, copied from the values the worker already used:

```
DATABASE_URL=…        → Neon: ep-wild-poetry-be212giz-pooler.c-9.us-east-2.aws.neon.tech
BLOB_READ_WRITE_TOKEN=…  → the same Vercel Blob token as the Render service
```

It lives outside any checkout on purpose: the Render checkout's own `.env.local`
points `DATABASE_URL` at `postgres:5432` (Docker-only, unreachable from this Mac),
and the worker must not depend on a temporary worktree that may be deleted.

**Restart the worker after any change to the worker file:**

```bash
uid=$(id -u)
launchctl bootout gui/$uid/com.ph-news-workbench.download-worker
launchctl bootstrap gui/$uid ~/Library/LaunchAgents/com.ph-news-workbench.download-worker.plist
```

If the blob token ever rotates, update `~/.config/ph-news-workbench/download-worker.env`
and restart the agent the same way.

**Heads-up:** the worker only prunes blobs for jobs **it** uploads. A job that was
already in the store before this fix keeps its old siblings until it is deleted (the
folder delete now handles that) or re-downloaded.

---

## 5. Merging / deploying

Nothing is pushed yet. To ship it:

```bash
cd /Users/roelsomido/ph-news-workbench-hf
git push origin main          # 2 commits: 7111009, 0b238b0
```

Pushing to `main` on `Datanerdbytes/ph-news-workbench-render` triggers
`.github/workflows/deploy.yml` → `ci.yml` → `scripts/render-deploy.mjs` → Render →
`scripts/verify-production.mjs` health check. `main` has branch protection requiring
4 checks (`Static analysis & lint`, `Unit & integration tests`, `Docker build & scan`,
`E2E against the production container`); all four pass locally, but `enforce_admins`
is on, so the first push may need a bypass.

`work/agent-prep` still points at the same commits and can be deleted after the push:

```bash
git branch -d work/agent-prep
git worktree remove /Users/roelsomido/ph-news-workbench-hf-rd
```

---

## 6. Housekeeping / things to know

- **Your WIP is untouched.** The main checkout still shows exactly the 11 deleted
  YouTube files (`app/api/youtube/**`, `app/youtube/page.tsx` + tests) and the
  untracked `LIVE-RESTREAM-PLAN.md`. The fast-forward of `main` did not touch those paths.
- **The Vercel repo was not modified.** It was only *read*, to copy the worker env
  values. The running worker no longer depends on it.
- **The disk scan is development-only.** `app/api/downloads/route.ts` merges local disk
  downloads only when `NODE_ENV === "development"`; the deployed Render app runs
  `NODE_ENV=production`, so the deployed list always showed one row per job. The
  disk-side fix mainly protects the local dev experience and the worker output.
- **The duplicated local downloads folder** (old jobs that still hold a source next to
  their rendition) is untouched — you said you'd clean that yourself. New downloads no
  longer create that state.
- `lib/storage.ts` `deleteStagedBlobsInFolder` is blob-only for the folder part; the
  s3 and hf drivers fall back to deleting just the recorded file (the hf client has no
  folder-listing API).
- The Vercel Blob account is paused but Blob still works — storage driver stays `blob`.

---

## 7. Quick file map

```
download-worker.ts              worker: download → convert → upload → prune blobs → remove source
download-worker.blobs.test.ts   worker blob-pruning tests (new)
download-worker.convert.test.ts worker conversion tests
download-worker.test.ts         worker unit tests
lib/downloads/disk-jobs.ts      one file per job folder (rendition preferred)
lib/downloads/disk-jobs.test.ts
lib/storage.ts                  deleteStagedBlobsInFolder (whole folder) + deleteStagedBlobs
lib/storage.test.ts
lib/blob.ts                     storage re-exports
app/api/downloads/route.ts      GET list (folder dedupe) + POST queue
app/api/downloads/route.test.ts
app/api/downloads/[id]/route.ts GET one job + DELETE (whole folder)
app/api/downloads/[id]/route.test.ts
```
