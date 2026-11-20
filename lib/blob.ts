/**
 * Staging storage entry points. The driver dispatch (Vercel Blob, an
 * S3-compatible bucket, or a private Hugging Face dataset repo) lives in
 * `@/lib/storage` — these re-exports keep every publish route's imports
 * stable no matter which driver is active.
 */
export {
  assertStagedBlob,
  deleteStagedBlobs,
  deleteStagedBlobsInFolder,
  stagedFileExtension,
  stagedFileToBuffer,
  stagedFileToTempFile,
} from '@/lib/storage';
