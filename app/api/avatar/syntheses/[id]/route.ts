import { NextResponse } from "next/server";
import { deleteAvatarSynthesis } from "@/lib/avatar/azure";
import { publicAvatarJob } from "@/lib/avatar/jobs";
import {
  getAvatarJob,
  removeAvatarJob,
  requestAvatarCancellation,
} from "@/lib/avatar/queue";
import { deleteStagedBlobs } from "@/lib/storage";
import { requireWorkspace, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const { id } = await context.params;
  const job = await getAvatarJob(id, access.workspace.id);
  if (!job) {
    return NextResponse.json(
      { error: "Avatar job not found.", code: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(publicAvatarJob(job), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(request: Request, context: Context) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const { id } = await context.params;
  const job = await getAvatarJob(id, access.workspace.id);
  if (!job) {
    return NextResponse.json(
      { error: "Avatar job not found.", code: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (["queued", "submitting", "running", "downloading", "finalizing"].includes(job.status)) {
    const cancelled = await requestAvatarCancellation(id, access.workspace.id);
    if (!cancelled) {
      return NextResponse.json(
        { error: "This avatar is being published and cannot be cancelled.", code: "in_use" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(publicAvatarJob(cancelled), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const removed = await removeAvatarJob(id, access.workspace.id);
  if (!removed) {
    return NextResponse.json(
      { error: "This avatar is attached to a published or scheduled post.", code: "in_use" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (removed.blobUrl) await deleteStagedBlobs([removed.blobUrl]);
  if (removed.providerSynthesisId) {
    try {
      await deleteAvatarSynthesis(removed.providerSynthesisId);
    } catch {
      // The local row is already gone; Azure expires the remote output.
    }
  }
  return NextResponse.json(
    { deleted: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
