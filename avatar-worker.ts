import { randomUUID } from "node:crypto";
import { avatarEndpoint } from "./lib/avatar/azure";
import {
  claimNextAvatarJob,
  recoverStaleAvatarJobs,
} from "./lib/avatar/queue";
import { processAvatarJob } from "./lib/avatar/worker";

const workerId = randomUUID();
let stopping = false;
const active = new Set<Promise<void>>();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  avatarEndpoint();
  console.log(`Avatar worker ready (${workerId}).`);

  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    try {
      await recoverStaleAvatarJobs();
      while (!stopping && active.size < 2) {
        const job = await claimNextAvatarJob(workerId);
        if (!job) break;
        const task = processAvatarJob(job)
          .catch(() => {
            console.error(
              JSON.stringify({
                event: "avatar_job_failed",
                jobId: job.id,
                error: "The avatar job could not be processed.",
              }),
            );
          })
          .finally(() => active.delete(task));
        active.add(task);
      }
    } catch {
      console.error(
        JSON.stringify({
          event: "avatar_queue_poll_failed",
          error: "The avatar queue could not be reached.",
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await Promise.allSettled([...active]);
}

main().catch(() => {
  console.error(
    JSON.stringify({
      event: "avatar_worker_failed",
      error: "The avatar worker could not start.",
    }),
  );
  process.exitCode = 1;
});
