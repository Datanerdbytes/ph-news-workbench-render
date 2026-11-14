import busboy from 'busboy';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Streaming multipart upload handling and file-body plumbing for the video
 * publish routes. Videos used to be read whole into the Node heap
 * (request.formData() + arrayBuffer() — two full copies of the file), which
 * OOM-killed the 512 MB Render instance on any sizeable upload. Everything
 * here streams: file parts spool straight to a temp dir, and uploads read
 * back from disk so heap use stays constant no matter the file size.
 */

export type SpooledFile = {
  kind: 'file';
  path: string;
  size: number;
  type: string;
  filename: string;
};

export type BufferedFile = {
  kind: 'buffer';
  buffer: Buffer;
  type: string;
  filename: string;
};

export type ParsedUploadFile = SpooledFile | BufferedFile;

/**
 * MIME types we can infer from a filename. request.formData() sniffed the
 * type from the extension when a part carried no Content-Type header; busboy
 * reports 'text/plain' instead, which turned the routes' extension fallback
 * into dead code and rejected valid uploads.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * The MIME type to trust for an uploaded part: the declared one when the
 * client sent it, otherwise the one the filename implies.
 *
 * busboy reports 'text/plain' for a part with no Content-Type header, while
 * request.formData() sniffed the extension and produced a real type — so the
 * routes' `!type && /\.(mp4|mov)$/` fallback never fired and valid uploads
 * were rejected with "Upload an MP4 or MOV video.".
 */
export function uploadedFileType(file: ParsedUploadFile): string {
  if (file.type && file.type !== 'text/plain') return file.type;
  return MIME_BY_EXTENSION[path.extname(file.filename).toLowerCase()] ?? '';
}

export type ParsedMultipart = {
  /** Temp dir holding every spooled file — remove it via cleanupParsedMultipart. */
  workDir: string;
  fields: Record<string, string>;
  files: Record<string, ParsedUploadFile>;
};

export type MultipartSpec = Record<
  string,
  { maxBytes: number; spool: 'file' | 'memory' }
>;

/** One file part blew past its cap in the spec. */
export class MultipartTooLargeError extends Error {
  constructor(
    public readonly part: string,
    public readonly maxBytes: number
  ) {
    super(`"${part}" exceeds the ${formatBytes(maxBytes)} limit.`);
    this.name = 'MultipartTooLargeError';
  }
}

export class MultipartParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipartParseError';
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024 * 1024))} GB`;
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

/**
 * Stream-parse a multipart request. Parts named in `spec` are captured —
 * `spool: 'file'` streams them into the temp workDir, `spool: 'memory'`
 * collects them as a Buffer (use for small parts like thumbnails only).
 * Unknown parts are drained and ignored. Cleanup is the caller's job:
 * `cleanupParsedMultipart` in a finally block.
 */
export async function parseMultipartToDisk(
  request: Request,
  spec: MultipartSpec
): Promise<ParsedMultipart> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw new MultipartParseError('Expected a multipart upload.');
  }
  if (!request.body) {
    throw new MultipartParseError('The upload body is empty.');
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'ph-upload-'));
  const partCaps = Object.values(spec).map((s) => s.maxBytes);
  const maxPartBytes = partCaps.length > 0 ? Math.max(...partCaps) : 0;

  try {
    const { fields, files } = await new Promise<{
      fields: Record<string, string>;
      files: Record<string, ParsedUploadFile>;
    }>((resolve, fail) => {
      const bb = busboy({
        headers: { 'content-type': contentType },
        limits: {
          // busboy truncates file parts at fileSize and fires 'limit' on the
          // part stream — we treat that as a hard rejection, never a silent
          // cut. Memory-spool parts enforce their own cap while streaming.
          fileSize: maxPartBytes,
          fields: 50,
          fieldSize: 1024 * 1024,
          files: Object.keys(spec).length + 5,
        },
      });

      let settled = false;
      const fields: Record<string, string> = {};
      const files: Record<string, ParsedUploadFile> = {};
      // Write-completion promises for spooled parts — 'close' must not
      // resolve the parse until every temp file is fully flushed to disk,
      // or the route would ffprobe/publish a truncated file.
      const spools: Promise<void>[] = [];
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) fail(error);
        else resolve({ fields, files });
      };

      const abort = (error: Error) => {
        // Stop the pump and unwind: destroy everything, then surface the
        // error. Late stream errors after settle are harmless.
        bb.removeAllListeners('close');
        bb.destroy(error);
        finish(error);
      };

      bb.on('field', (name, value) => {
        fields[name] = value;
      });

      bb.on('file', (name, fileStream, info) => {
        // Own properties only: a part named "constructor" or "toString"
        // would otherwise resolve to an inherited Object.prototype member
        // and be spooled to workDir/<name>.
        const entry = Object.hasOwn(spec, name) ? spec[name] : undefined;
        if (!entry || files[name]) {
          fileStream.resume(); // Unknown or duplicate part — drain it.
          return;
        }

        if (entry.spool === 'memory') {
          const chunks: Buffer[] = [];
          let total = 0;
          fileStream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > entry.maxBytes) {
              abort(new MultipartTooLargeError(name, entry.maxBytes));
              return;
            }
            chunks.push(chunk);
          });
          // busboy truncates at the global fileSize cap and fires 'limit' —
          // when a part's own cap equals that global cap, 'limit' is the
          // definitive over-cap signal (the data guard above can't see past
          // the truncation point).
          fileStream.on('limit', () => {
            abort(new MultipartTooLargeError(name, entry.maxBytes));
          });
          fileStream.on('end', () => {
            files[name] = {
              kind: 'buffer',
              buffer: Buffer.concat(chunks),
              type: info.mimeType,
              filename: info.filename ?? '',
            };
          });
          fileStream.on('error', abort);
          return;
        }

        const filePath = path.join(workDir, name);
        const out = createWriteStream(filePath);
        let size = 0;
        fileStream.on('data', (chunk: Buffer) => {
          size += chunk.length;
        });
        // busboy's fileSize cap applies per part (set to the spec's max);
        // 'limit' means this part reached it — for parts with a smaller
        // entry cap the data-counting route never reaches this point, so
        // reporting entry.maxBytes here is still accurate.
        fileStream.on('limit', () => {
          abort(new MultipartTooLargeError(name, entry.maxBytes));
        });
        fileStream.on('error', abort);
        out.on('error', abort);
        fileStream.on('end', () => {
          files[name] = {
            kind: 'file',
            path: filePath,
            size,
            type: info.mimeType,
            filename: info.filename ?? '',
          };
        });
        spools.push(
          pipeline(fileStream, out).catch((error) => {
            // An abort path rejects with a premature-close — swallow it when
            // the parse has already settled; surface anything else.
            if (!settled) abort(error as Error);
          })
        );
      });

      bb.on('error', abort);
      bb.on('close', () => {
        void Promise.all(spools)
          .then(() => finish())
          .catch(() => {
            // Already settled by the abort path.
          });
      });

      const source = Readable.fromWeb(
        request.body as unknown as import('node:stream/web').ReadableStream
      );
      source.on('error', abort);
      source.pipe(bb as unknown as Writable);
    });

    return { workDir, fields, files };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

/** Remove the temp dir a parseMultipartToDisk result spooled into. */
export async function cleanupParsedMultipart(parsed: ParsedMultipart): Promise<void> {
  await rm(parsed.workDir, { recursive: true, force: true });
}

/**
 * A streaming request body from a file on disk — the upload counterpart to
 * what `app/api/downloads/[id]/file/route.ts` does for responses. Fetch calls
 * pair this with an explicit content-length header so the wire format matches
 * a buffered upload byte-for-byte.
 */
export function fileBodyStream(filePath: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
}

/** Fetch init for a streaming file upload with a fixed content-length. */
export function fileUploadInit(
  filePath: string,
  size: number,
  base: RequestInit = {}
): RequestInit {
  const headers = new Headers(base.headers);
  headers.set('content-length', String(size));
  return {
    ...base,
    headers,
    body: fileBodyStream(filePath),
    // undici requires duplex: 'half' whenever the body is a stream.
    duplex: 'half',
  } as RequestInit;
}
