export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The media sandbox bootstraps first and independently of the scheduler
  // guards: it is what makes native media execution safe, and its proxies
  // live for the whole server process. It fails closed on its own if the
  // platform primitives are missing (see lib/live/media-sandbox.ts).
  const mediaSandbox = await import("./lib/live/media-sandbox");
  await mediaSandbox.ensureMediaSandbox();

  try {
    const { ensureAvatarJobColumns } = await import("./lib/avatar/queue");
    await ensureAvatarJobColumns();
  } catch (error) {
    console.error("[avatar-schema] failed to ensure avatar job columns", error);
  }

  const onVercel = Boolean(process.env.VERCEL);
  const production = process.env.NODE_ENV === "production";

  // On Vercel the cron declared in vercel.json is the executor — a timer
  // inside a serverless function is not reliable. Anywhere else (self-hosted
  // or a long-running Node server) the in-process timer is the right answer.
  if (production && onVercel) return;

  // Kill switch for multi-host setups: two long-running deployments pointed
  // at the same database would each run this timer and race for due posts.
  // Set DISABLE_LOCAL_SCHEDULER=1 on the copy that must not sweep.
  if (process.env.DISABLE_LOCAL_SCHEDULER === "1") return;

  const scheduler = await import("./lib/local-scheduler");
  scheduler.startLocalScheduler();
}
