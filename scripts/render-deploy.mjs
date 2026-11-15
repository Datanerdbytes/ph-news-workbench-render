#!/usr/bin/env node

/**
 * Trigger a Render deploy for one commit and wait for Render to report it.
 *
 * The Render API is the only source that can tell a shipped deploy from a
 * failed one. A failed build leaves the previous version serving, so the
 * health endpoint alone cannot tell "deployed" from "never deployed" — the
 * deploy status can.
 *
 * The API key is only ever sent in the Authorization header and never reaches
 * the log.
 */

const API_BASE = "https://api.render.com/v1";

export const LIVE_STATUS = "live";

export const FAILURE_STATUSES = [
  "build_failed",
  "update_failed",
  "pre_deploy_failed",
  "canceled",
  "deactivated",
];

export const PENDING_STATUSES = [
  "created",
  "queued",
  "pre_deploy_in_progress",
  "build_in_progress",
  "update_in_progress",
];

/**
 * @param {string | undefined} status
 * @returns {"live" | "failed" | "pending" | "unknown"}
 */
export function classifyStatus(status) {
  if (status === LIVE_STATUS) return "live";
  if (FAILURE_STATUSES.includes(status ?? "")) return "failed";
  if (PENDING_STATUSES.includes(status ?? "")) return "pending";
  return "unknown";
}

/**
 * @param {string | undefined} status
 * @returns {string}
 */
export function describeStatus(status) {
  switch (status) {
    case "build_failed":
      return "the Docker build failed";
    case "update_failed":
      return "the deploy failed while the new instance was starting";
    case "pre_deploy_failed":
      return "the pre-deploy command failed";
    case "canceled":
      return "the deploy was canceled";
    case "deactivated":
      return "the service was deactivated before the deploy went live";
    case LIVE_STATUS:
      return "the deploy is live";
    default:
      return `the deploy is in status "${status ?? "unknown"}"`;
  }
}

/**
 * @param {unknown} payload
 * @returns {string | null}
 */
export function readDeployId(payload) {
  const id =
    payload && typeof payload === "object"
      ? /** @type {{ deploy?: { id?: unknown } }} */ (payload).deploy?.id
      : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Render answers a create-deploy request with `202` and an empty body when the
 * service already has a deploy in flight — the new deploy is queued behind it
 * and only shows up in the deploy list. The list is ordered newest first and
 * every entry wraps the deploy in a `deploy` key.
 *
 * @param {unknown} payload
 * @param {string} commitId
 * @returns {string | null}
 */
export function findDeployIdByCommit(payload, commitId) {
  const entries = Array.isArray(payload)
    ? payload
    : /** @type {{ deploys?: unknown[] }} */ (payload)?.deploys ?? [];
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const deploy = /** @type {{ deploy?: { id?: unknown, commit?: { id?: unknown } } }} */ (entry)
      ?.deploy;
    const id = deploy?.id;
    const deployCommit = deploy?.commit?.id;
    if (
      typeof id === "string" &&
      id.length > 0 &&
      typeof deployCommit === "string" &&
      sameCommit(deployCommit, commitId)
    ) {
      return id;
    }
  }

  return null;
}

/**
 * @param {string} serviceId
 * @param {string} deployId
 * @returns {string}
 */
export function dashboardUrl(serviceId, deployId) {
  return `https://dashboard.render.com/web/${serviceId}/deploys/${deployId}`;
}

/**
 * Render reports the full commit sha while a workflow usually holds a short
 * one, so the comparison is by prefix in both directions.
 *
 * @param {string | undefined} left
 * @param {string | undefined} right
 * @returns {boolean}
 */
export function sameCommit(left, right) {
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * @param {string} path
 * @param {{ apiKey: string, method?: string, body?: unknown, fetchImpl?: typeof fetch }} options
 */
async function request(path, { apiKey, method = "GET", body, fetchImpl = fetch }) {
  const doFetch = fetchImpl;
  const response = await doFetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      (payload && typeof payload === "object"
        ? /** @type {{ message?: unknown, error?: unknown }} */ (payload).message ??
          /** @type {{ message?: unknown, error?: unknown }} */ (payload).error
        : null) ?? text.slice(0, 300);
    throw new Error(
      `Render API ${method} ${path} failed with ${response.status}: ${detail || "(no detail)"}`,
    );
  }

  return payload;
}

/**
 * @param {{ apiKey: string, serviceId: string, commitId: string, clearCache?: string, fetchImpl?: typeof fetch }} options
 */
export async function triggerDeploy({
  apiKey,
  serviceId,
  commitId,
  clearCache = "do_not_clear",
  fetchImpl = fetch,
}) {
  const payload = await request(`/services/${serviceId}/deploys`, {
    apiKey,
    method: "POST",
    body: { commitId, clearCache },
    fetchImpl,
  });

  const deployId = readDeployId(payload);
  if (deployId) {
    return { deployId, deploy: payload };
  }

  // A queued-behind-another-deploy answer carries no id, so the deploy has to
  // be picked out of the service's recent deploys by its commit.
  const list = await request(`/services/${serviceId}/deploys?limit=10`, {
    apiKey,
    fetchImpl,
  });
  const queuedId = findDeployIdByCommit(list, commitId);
  if (queuedId) {
    return { deployId: queuedId, deploy: null };
  }

  throw new Error(
    "Render accepted the deploy but returned no deploy id, and no queued deploy for that commit is listed.",
  );
}

/**
 * @param {{ apiKey: string, serviceId: string, deployId: string, timeoutMs: number, pollIntervalMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (message: string) => void }} options
 */
export async function waitForDeploy({
  apiKey,
  serviceId,
  deployId,
  timeoutMs,
  pollIntervalMs = 15_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  for (;;) {
    const payload = await request(`/services/${serviceId}/deploys/${deployId}`, {
      apiKey,
      fetchImpl,
    });
    const status = payload?.status;

    if (status !== lastStatus) {
      log(`deploy ${deployId} is ${status ?? "in an unknown state"}`);
      lastStatus = status;
    }

    const state = classifyStatus(status);
    if (state === "live") return payload;
    if (state === "failed") {
      throw new Error(`the deploy did not go live: ${describeStatus(status)}`);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the deploy did not finish within the timeout (last status: ${status ?? "unknown"}).`,
      );
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Trigger the deploy, wait for it and check that the commit that went live is
 * the one that was asked for.
 *
 * @param {{ apiKey: string, serviceId: string, commitId: string, timeoutMs: number, clearCache?: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (message: string) => void }} options
 */
export async function runDeploy({
  apiKey,
  serviceId,
  commitId,
  timeoutMs,
  clearCache,
  fetchImpl,
  sleep,
  log = () => {},
}) {
  log(`triggering a Render deploy for commit ${commitId}`);
  const { deployId } = await triggerDeploy({
    apiKey,
    serviceId,
    commitId,
    clearCache,
    fetchImpl,
  });
  log(`deploy ${deployId} started — follow it at ${dashboardUrl(serviceId, deployId)}`);

  const deploy = await waitForDeploy({
    apiKey,
    serviceId,
    deployId,
    timeoutMs,
    fetchImpl,
    sleep,
    log,
  });

  const deployedCommit = deploy?.commit?.id;
  if (!sameCommit(deployedCommit, commitId)) {
    throw new Error(
      `the deploy went live with commit ${deployedCommit ?? "unknown"} instead of ${commitId}.`,
    );
  }

  return { deployId, deploy, commitId: deployedCommit };
}

async function main() {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  const commitId = process.env.RENDER_DEPLOY_SHA || process.env.GITHUB_SHA;
  const timeoutMinutes = Number(process.env.RENDER_DEPLOY_TIMEOUT_MINUTES || 30);

  if (!apiKey) {
    throw new Error(
      "RENDER_API_KEY is not set — add the Render API key as the RENDER_API_KEY repository secret.",
    );
  }
  if (!serviceId) {
    throw new Error(
      "RENDER_SERVICE_ID is not set — add the Render service id as the RENDER_SERVICE_ID repository variable.",
    );
  }
  if (!commitId) {
    throw new Error("no commit to deploy — set RENDER_DEPLOY_SHA or GITHUB_SHA.");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(commitId)) {
    throw new Error(
      `"${commitId}" is not a commit sha — set RENDER_DEPLOY_SHA to the commit that should go live.`,
    );
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("RENDER_DEPLOY_TIMEOUT_MINUTES must be a positive number of minutes.");
  }

  const { deployId } = await runDeploy({
    apiKey,
    serviceId,
    commitId,
    timeoutMs: timeoutMinutes * 60_000,
    log: (message) => console.log(message),
  });

  console.log(`deploy ${deployId} is live`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
