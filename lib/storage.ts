import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { del, head } from '@vercel/blob';
import { deleteFiles, uploadFile } from '@huggingface/hub';

/**
 * Server-side staging storage behind one small driver interface.
 *
 * The workbench stages media straight from the browser so publish routes can
 * fetch it without a request-body cap. On Vercel that store is Vercel Blob
 * (driver "blob"). Self-hosted copies can point staging at any S3-compatible
 * bucket (driver "s3" — Cloudflare R2, Backblaze B2, Wasabi, MinIO…) or a
 * private Hugging Face dataset repo (driver "hf").
 *
 * STORAGE_DRIVER picks the driver at runtime; every driver implements the
 * same four verbs so publish routes never care which one is active:
 *   - isManagedStagedUrl: cheap shape check — reject URLs we did not stage
 *   - assertStagedBlob: authenticated check before fetching or deleting
 *   - stagedFileToBuffer: read a staged file into memory
 *   - stagedFileToTempFile: stream a staged file to a temp file on disk
 *   - deleteStagedBlobs: best-effort cleanup
 *
 * Driver credentials are read from the environment on every call, so switching
 * drivers on a running container only takes a restart.
 */

export type StorageDriver = 'blob' | 's3' | 'hf';

const BLOB_HOST = '.public.blob.vercel-storage.com';
const HF_RESOLVE_PREFIX = 'https://huggingface.co/datasets/';

export function getStorageDriver(): StorageDriver {
  // STORAGE_DRIVER wins at runtime; NEXT_PUBLIC_STORAGE_DRIVER is the
  // build-time value baked into the client bundle. Both must agree — the
  // client stages and the server reads/deletes, so a split-brain config
  // would stage into one store and verify against another. Falling back to
  // the public value when the runtime one is unset keeps a single source of
  // truth on hosts that cannot inject build env (HF Spaces).
  const raw = (
    process.env.STORAGE_DRIVER?.trim() ||
    process.env.NEXT_PUBLIC_STORAGE_DRIVER?.trim() ||
    'blob'
  ).toLowerCase();
  if (raw === 'blob') return 'blob';
  if (raw === 's3' || raw === 'hf') return raw;
  throw new Error(`STORAGE_DRIVER must be "blob", "s3" or "hf" (got "${raw}").`);
}

function blobRoot(): string {
  return process.env.NEXT_PUBLIC_BLOB_ROOT?.trim() ?? '';
}

function s3PublicBase(): string {
  return (process.env.S3_PUBLIC_BASE ?? '').trim().replace(/\/+$/, '');
}

function s3Bucket(): string {
  return process.env.S3_BUCKET?.trim() ?? '';
}

function hfRepo(): string {
  return process.env.HF_STAGING_REPO?.trim() ?? '';
}

/**
 * Storage token for the hf driver. HF_TOKEN is the standard name; HF_API_KEY
 * is accepted as a fallback because the AI features already provision it —
 * same account, same token kinds.
 */
function hfToken(): string {
  return process.env.HF_TOKEN?.trim() || process.env.HF_API_KEY?.trim() || '';
}

function requireS3Config(): void {
  const missing = [
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_PUBLIC_BASE',
  ].filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `The s3 storage driver is missing ${missing.join(', ')}.`
    );
  }
}

function requireHfConfig(): string {
  const token = hfToken();
  if (!token) throw new Error('The hf storage driver needs HF_TOKEN (or HF_API_KEY).');
  const repo = hfRepo();
  if (!repo) throw new Error('The hf storage driver needs HF_STAGING_REPO (e.g. "username/workbench-staging").');
  return token;
}

let s3Client: S3Client | undefined;

function s3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.S3_REGION?.trim() || 'auto',
      endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() ?? '',
      },
    });
  }
  return s3Client;
}

function s3KeyFromUrl(url: string): string | null {
  const base = s3PublicBase();
  if (base === '' || !url.startsWith(`${base}/`)) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    return null;
  }
}

function hfPathFromUrl(url: string): string | null {
  const repo = hfRepo();
  const prefix = `${HF_RESOLVE_PREFIX}${repo}/resolve/main/`;
  if (repo === '' || !url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
}

/**
 * Staged keys get a short random suffix for the same reason the blob driver
 * sets addRandomSuffix — two tabs uploading `photos/<ts>-me.png` in the same
 * millisecond must not collide.
 */
function stagedKey(pathname: string): string {
  return `${pathname.replace(/^\/+/, '')}-${randomUUID().slice(0, 8)}`;
}

/**
 * The extension of a staged file, lowercased.
 *
 * stagedKey() appends "-<uuid8>" AFTER the pathname, so a staged ".mov"
 * reads as ".mov-a1b2c3d4" and every extension check downstream silently
 * failed. The blob driver keeps the suffix before the extension, so the
 * strip only ever applies to the s3 and hf keys.
 */
export function stagedFileExtension(url: string): string {
  const pathname = new URL(url).pathname;
  return path.extname(pathname.replace(/-[0-9a-f]{8}$/, '')).toLowerCase();
}

/**
 * True when a URL was staged by this app under the active driver. Publish
 * routes hand URLs to Meta/YouTube from here, so foreign URLs must never
 * pass — this shape check is the cheap first gate; `assertStagedBlob` is the
 * authenticated one.
 */
export function isManagedStagedUrl(url: string): boolean {
  switch (getStorageDriver()) {
    case 'blob': {
      const root = blobRoot();
      return (root === '' || url.startsWith(root)) && url.includes(BLOB_HOST);
    }
    case 's3': {
      const base = s3PublicBase();
      return base !== '' && url.startsWith(`${base}/`);
    }
    case 'hf': {
      const repo = hfRepo();
      return (
        repo !== '' &&
        url.startsWith(`${HF_RESOLVE_PREFIX}${repo}/resolve/main/`)
      );
    }
  }
}

/**
 * Verify a staged URL belongs to our store before fetching or deleting it.
 * `head()` authenticates against the store, so a fabricated or foreign URL is
 * refused here and never trusted from the client alone.
 */
export async function assertStagedBlob(url: string): Promise<void> {
  switch (getStorageDriver()) {
    case 'blob':
      await head(url);
      return;
    case 's3': {
      requireS3Config();
      const key = s3KeyFromUrl(url);
      if (!key) throw new Error('The staged URL does not belong to this app.');
      await s3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }));
      return;
    }
    case 'hf': {
      const token = requireHfConfig();
      const path = hfPathFromUrl(url);
      if (!path) throw new Error('The staged URL does not belong to this app.');
      // Private repos answer a token'd HEAD with a redirect to the CDN — any
      // of 2xx/3xx proves the file exists and the token may read it.
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual',
        cache: 'no-store',
      });
      if (response.status >= 400) {
        throw new Error('The staged file could not be verified.');
      }
    }
  }
}

/**
 * Download a staged file into memory. Used by publishing routes: the browser
 * stages the file to storage directly (client → storage, no function in
 * between) and the route reads it from there.
 */
export async function stagedFileToBuffer(url: string): Promise<Buffer> {
  await assertStagedBlob(url);
  const headers: Record<string, string> = {};
  if (getStorageDriver() === 'hf') {
    headers.Authorization = `Bearer ${requireHfConfig()}`;
  }
  const response = await fetch(url, { cache: 'no-store', headers });
  if (!response.ok) {
    throw new Error('The staged upload could not be read.');
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Streaming twin of stagedFileToBuffer: download a staged file to a temp dir
 * instead of the heap, so publishing a staged 1 GB video never OOMs a small
 * instance. Caller removes the returned workDir (rm -rf) when done.
 */
export async function stagedFileToTempFile(
  url: string
): Promise<{ workDir: string; path: string; size: number }> {
  await assertStagedBlob(url);
  const headers: Record<string, string> = {};
  if (getStorageDriver() === 'hf') {
    headers.Authorization = `Bearer ${requireHfConfig()}`;
  }
  const response = await fetch(url, { cache: 'no-store', headers });
  if (!response.ok || !response.body) {
    throw new Error('The staged upload could not be read.');
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'ph-staged-'));
  const suffix = stagedFileExtension(url);
  const filePath = path.join(
    workDir,
    ['.mp4', '.mov', '.webm'].includes(suffix) ? `video${suffix}` : 'video'
  );

  try {
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as import('node:stream/web').ReadableStream
      ),
      createWriteStream(filePath)
    );
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }

  const { size } = await stat(filePath);
  return { workDir, path: filePath, size };
}

/**
 * Best-effort cleanup — staging copies are transient (the platform either has
 * the file or the user re-stages it), so a failed delete never breaks the
 * response.
 */
export async function deleteStagedBlobs(urls: string[]): Promise<void> {
  if (!urls.length) return;
  try {
    switch (getStorageDriver()) {
      case 'blob':
        await del(urls);
        return;
      case 's3': {
        requireS3Config();
        await Promise.all(
          urls.map((url) => {
            const key = s3KeyFromUrl(url);
            if (!key) return Promise.resolve();
            return s3().send(
              new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key })
            );
          })
        );
        return;
      }
      case 'hf': {
        const token = requireHfConfig();
        const paths = urls
          .map((url) => hfPathFromUrl(url))
          .filter((path): path is string => path !== null);
        if (!paths.length) return;
        // One commit for the whole batch — HF bills a commit per call.
        await deleteFiles({
          repo: { type: 'dataset', name: hfRepo() },
          paths,
          credentials: { accessToken: token },
        });
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        route: 'storage',
        event: 'delete_failed',
        count: urls.length,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

/**
 * Mint a short-lived direct-upload URL for the s3 driver — the browser PUTs
 * the file straight to the bucket, so multi-hundred-MB reels never cross the
 * app server.
 */
export async function presignStagedUpload(
  pathname: string,
  contentType: string
): Promise<{ uploadUrl: string; publicUrl: string }> {
  requireS3Config();
  const key = stagedKey(pathname);
  const command = new PutObjectCommand({
    Bucket: s3Bucket(),
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3(), command, { expiresIn: 3600 });
  return { uploadUrl, publicUrl: `${s3PublicBase()}/${key}` };
}

/**
 * Upload through the app server into the private HF dataset repo (hf driver).
 * HF offers no direct browser uploads, so the file crosses the app once —
 * fine for photos and clips; very large reels are better on the s3 driver.
 */
export async function stageFileToRepo(
  pathname: string,
  file: File
): Promise<string> {
  const token = requireHfConfig();
  const path = stagedKey(pathname);
  await uploadFile({
    repo: { type: 'dataset', name: hfRepo() },
    // v1 API: the destination path rides in `file` as {path, content}.
    file: { path, content: file },
    credentials: { accessToken: token },
  });
  return `${HF_RESOLVE_PREFIX}${hfRepo()}/resolve/main/${path}`;
}
