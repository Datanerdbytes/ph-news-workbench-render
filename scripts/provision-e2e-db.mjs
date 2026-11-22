// Resolves the database the E2E suite runs against.
//
// The "Provision the E2E database" step in .github/workflows/ci.yml runs this
// script's ensure mode, and a final always() step runs teardown.
//
//   ensure — when the E2E_DATABASE_URL override is set and answers SELECT 1,
//   that URL is reused as-is (the persistent ci-e2e branch, while it lives).
//   Otherwise a fresh Neon branch named ci-e2e-run-<run id> is created from
//   the production parent, the schema it copied along is wiped, and the
//   connection string is exported to $GITHUB_ENV. Neon's free plan deletes
//   non-primary branches seven days after creation, so a persistent branch
//   expires under CI roughly weekly; a branch created per run — and deleted
//   by teardown — never gets the chance. Before creating its branch, ensure
//   also deletes any leftover ci-e2e-run-* branches: the job's concurrency
//   group guarantees no other E2E run is using one, so anything left is an
//   orphan from a crashed runner.
//
//   teardown — deletes the branch ensure created (NEON_BRANCH_ID). A missing
//   id means the override was used, and any API failure only warns: the next
//   ensure's sweep is the safety net.
//
// Inputs: NEON_API_KEY, NEON_PROJECT_ID, NEON_PARENT_BRANCH_ID,
// NEON_DATABASE (default "neondb"), NEON_ROLE (default "neondb_owner"),
// E2E_DATABASE_URL (optional override), NEON_BRANCH_ID (teardown), and the
// Actions-provided GITHUB_ENV / GITHUB_RUN_ID.
//
// The connection string carries neondb_owner's project-wide password — the
// same one production's Render credential uses, so it must never be reset in
// the Neon console — and is written to $GITHUB_ENV without ever being
// printed: it is masked first and $GITHUB_ENV is the only sink.
import { appendFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const API = "https://console.neon.tech/api/v2";
const BRANCH_PREFIX = "ci-e2e-run-";
const READY_ATTEMPTS = 12;
const READY_INTERVAL_MS = 5_000;

const mode = process.argv[2] ?? "ensure";

function log(message) {
  console.log(message);
}

function fail(message) {
  process.stdout.write(`::error::${message}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stdout.write(`::warning::${message}\n`);
}

function mask(value) {
  process.stdout.write(`::add-mask::${value}\n`);
}

function exportEnv(name, value) {
  const target = process.env.GITHUB_ENV;
  if (!target) {
    log(`GITHUB_ENV is not set — ${name} not exported (local run?)`);
    return;
  }
  appendFileSync(target, `${name}=${value}\n`);
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  timeout.catch(() => {}); // the loser of the race must not reject unhandled
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function neonApi(apiKey, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Neon API ${method} ${path} failed: ${response.status} ${details}`);
  }
  return response.json();
}

async function probe(databaseUrl, label) {
  const sql = neon(databaseUrl);
  await withTimeout(sql.query("SELECT 1"), 15_000, `${label} SELECT 1`);
}

async function ensure() {
  const override = process.env.E2E_DATABASE_URL?.trim();
  if (override) {
    try {
      await probe(override, "the E2E_DATABASE_URL override");
      exportEnv("E2E_DATABASE_URL", override);
      log("→ E2E_DATABASE_URL override is healthy, reusing it");
      return;
    } catch (error) {
      log(`E2E_DATABASE_URL override is unreachable (${error.message}) — provisioning a fresh branch`);
    }
  }

  const apiKey = process.env.NEON_API_KEY?.trim();
  const projectId = process.env.NEON_PROJECT_ID?.trim();
  const parentId = process.env.NEON_PARENT_BRANCH_ID?.trim();
  const databaseName = process.env.NEON_DATABASE?.trim() || "neondb";
  const roleName = process.env.NEON_ROLE?.trim() || "neondb_owner";
  if (!apiKey || !projectId || !parentId) {
    fail(
      "Neon provisioning needs NEON_API_KEY, NEON_PROJECT_ID and NEON_PARENT_BRANCH_ID " +
        "in the `e2e` environment (see docs/deployment.md), or a healthy E2E_DATABASE_URL override",
    );
  }

  // Orphan sweep: leftover ci-e2e-run-* branches can only come from a runner
  // that died mid-job, because the job queues one E2E run at a time. The
  // legacy `ci-e2e` branch and everything else is left untouched.
  const { branches } = await neonApi(apiKey, "GET", `/projects/${projectId}/branches`);
  for (const stale of branches.filter((branch) => branch.name?.startsWith(BRANCH_PREFIX))) {
    try {
      await neonApi(apiKey, "DELETE", `/projects/${projectId}/branches/${stale.id}`);
      log(`→ deleted leftover branch ${stale.name} (${stale.id})`);
    } catch (error) {
      warn(`could not delete leftover branch ${stale.name} (${stale.id}): ${error.message}`);
    }
  }

  const name = `${BRANCH_PREFIX}${process.env.GITHUB_RUN_ID?.trim() || Date.now()}`;
  const created = await neonApi(apiKey, "POST", `/projects/${projectId}/branches`, {
    branch: { name, parent_id: parentId },
    // The compute endpoint has to be requested together with the branch —
    // the API does not create one on its own, and without it there is
    // nothing to connect to.
    endpoints: [{ type: "read_write" }],
  });
  const branchId = created.branch.id;
  exportEnv("NEON_BRANCH_ID", branchId);

  const { uri } = await neonApi(
    apiKey,
    "GET",
    `/projects/${projectId}/connection_uri?branch_id=${branchId}&database_name=${databaseName}&role_name=${roleName}`,
  );
  mask(uri);
  const password = new URL(uri).password;
  if (password) {
    mask(decodeURIComponent(password));
  }

  // The endpoint scales up on first use, and a brand-new branch is not
  // connectable the instant the API returns — retry until SELECT 1 answers.
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
    try {
      await probe(uri, `branch endpoint (attempt ${attempt}/${READY_ATTEMPTS})`);
      break;
    } catch (error) {
      if (attempt === READY_ATTEMPTS) {
        fail(`the freshly created branch never became connectable: ${error.message}`);
      }
      log(`→ branch endpoint not ready yet (attempt ${attempt}/${READY_ATTEMPTS}): ${error.message}`);
      await sleep(READY_INTERVAL_MS);
    }
  }
  const sql = neon(uri);

  // A new branch is a byte copy of production — including its tables — and
  // prepare-e2e-db.mjs needs an empty schema to lay down the base schema
  // itself.
  await sql.query("DROP SCHEMA public CASCADE");
  await sql.query("CREATE SCHEMA public");

  exportEnv("E2E_DATABASE_URL", uri);
  log(`→ provisioned branch ${name} (${branchId}) from production with an empty public schema`);
}

async function teardown() {
  const branchId = process.env.NEON_BRANCH_ID?.trim();
  const apiKey = process.env.NEON_API_KEY?.trim();
  const projectId = process.env.NEON_PROJECT_ID?.trim();
  if (!branchId || !apiKey || !projectId) {
    log("→ nothing to delete (no NEON_BRANCH_ID / NEON_API_KEY / NEON_PROJECT_ID) — the override was likely used");
    return;
  }
  try {
    await neonApi(apiKey, "DELETE", `/projects/${projectId}/branches/${branchId}`);
    log(`→ deleted branch ${branchId}`);
  } catch (error) {
    if (/\b404\b/.test(error.message)) {
      log(`→ branch ${branchId} is already gone`);
      return;
    }
    warn(`could not delete branch ${branchId}: ${error.message} — the next ensure sweeps it`);
  }
}

if (mode === "ensure") {
  await ensure();
} else if (mode === "teardown") {
  await teardown();
} else {
  fail(`unknown mode "${mode}" — use ensure (default) or teardown`);
}
