import { getAvatarJob } from "@/lib/avatar/queue";
import { requireWorkspace, unauthorized } from "@/lib/session";
import { openStagedBlob } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AVATAR_BYTES = 256 * 1024 * 1024;

type Context = { params: Promise<{ id: string }> };

function validatedAvatarBody(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let size = 0;
  let header = new Uint8Array(0);
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_AVATAR_BYTES) {
          controller.error(new Error("The avatar video is too large."));
          return;
        }
        if (header.length < 8) {
          const needed = 8 - header.length;
          const combined = new Uint8Array(
            header.length + Math.min(needed, chunk.byteLength),
          );
          combined.set(header);
          combined.set(chunk.subarray(0, needed), header.length);
          header = combined;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (
          header.length < 8 ||
          String.fromCharCode(...header.subarray(4, 8)) !== "ftyp"
        ) {
          controller.error(
            new Error("The avatar source is not a valid MP4 video."),
          );
          return;
        }
      },
    }),
  );
}

export async function GET(request: Request, context: Context) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const { id } = await context.params;
  const job = await getAvatarJob(id, access.workspace.id);
  if (!job || job.status !== "completed" || !job.blob_url) {
    return Response.json(
      { error: "Avatar video not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const upstream = await openStagedBlob(job.blob_url);
    if (!upstream.body) throw new Error("The avatar video is empty.");
    const lengthHeader = upstream.headers.get("content-length");
    const contentLength = lengthHeader === null ? NaN : Number(lengthHeader);
    const storedSize = Number(job.file_size);
    if (
      (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) ||
      (Number.isFinite(storedSize) && storedSize > MAX_AVATAR_BYTES)
    ) {
      await upstream.body?.cancel().catch(() => {});
      return Response.json(
        { error: "The avatar video is too large." },
        { status: 413, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'inline; filename="avatar.mp4"',
      "X-Content-Type-Options": "nosniff",
    });
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      headers.set("Content-Length", String(contentLength));
    }
    return new Response(validatedAvatarBody(upstream.body), {
      status: 200,
      headers,
    });
  } catch {
    return Response.json(
      { error: "The avatar video could not be loaded." },
      { status: 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
