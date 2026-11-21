import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "provision-e2e-test-"));
const preload = join(scratch, "fetch-stub.mjs");
const calls = join(scratch, "calls.jsonl");
const githubEnv = join(scratch, "github-env");

// Exercise the script's real Neon driver and API client against a synthetic
// HTTP layer: api.neon.tech gets canned JSON, anything else is the SQL
// endpoint the serverless driver posts to. No database or credentials used.
writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
const log = (entry) => appendFileSync(process.env.CALLS_LOG, JSON.stringify(entry) + '\\n');
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes('api.neon.tech')) {
    const { pathname, search } = new URL(target);
    log({ kind: 'api', method: options.method, path: pathname + search, body: options.body ? JSON.parse(options.body) : null });
    if (process.env.API_FAIL_ON && (pathname + search).includes(process.env.API_FAIL_ON)) {
      return new Response(JSON.stringify({ message: 'synthetic api failure' }), { status: 500 });
    }
    if (options.method === 'GET' && pathname.endsWith('/branches')) {
      return new Response(JSON.stringify({ branches: JSON.parse(process.env.STALE_BRANCHES || '[]') }), { status: 200 });
    }
    if (options.method === 'POST' && pathname.endsWith('/branches')) {
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({ branch: { id: 'br-new', name: body.branch.name }, endpoints: [] }), { status: 201 });
    }
    if (options.method === 'GET' && pathname.endsWith('/connection_uri')) {
      return new Response(JSON.stringify({ uri: process.env.PROVISIONED_URL }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }
  const { query } = JSON.parse(options.body);
  log({ kind: 'sql', query });
  // The driver rewrites the SQL host (ep-X -> api.<rest>), so the database a
  // request belongs to is only visible in the connection string it carries.
  const connection = options.headers?.['Neon-Connection-String'] ?? target;
  if (process.env.DEAD_HOST && connection.includes(process.env.DEAD_HOST)) {
    return new Response(JSON.stringify({ message: 'synthetic database failure' }), { status: 400 });
  }
  return new Response(JSON.stringify({ fields: [], rows: [] }), { status: 200 });
};
`);

const overrideUrl = (host: string) =>
  `postgresql://neondb_owner:pw@${host}.aws.neon.build/neondb?sslmode=require`;
const provisionedUrl = overrideUrl("ep-provisioned");

afterEach(() => {
  rmSync(calls, { force: true });
  rmSync(githubEnv, { force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Call = { kind: string; method?: string; path?: string; body?: unknown; query?: string };

function provision(mode = "ensure", env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["scripts/provision-e2e-db.mjs", mode], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${preload}`,
      CALLS_LOG: calls,
      GITHUB_ENV: githubEnv,
      GITHUB_RUN_ID: "12345",
      NEON_API_KEY: "test-api-key",
      NEON_PROJECT_ID: "test-project",
      NEON_PARENT_BRANCH_ID: "br-parent",
      PROVISIONED_URL: provisionedUrl,
      ...env,
    },
  });
  const logged = existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
    : [];
  const exported = existsSync(githubEnv) ? readFileSync(githubEnv, "utf8") : "";
  return { result, logged, exported };
}

describe("E2E database provisioning", () => {
  it("reuses a healthy E2E_DATABASE_URL override without touching the Neon API", () => {
    const { result, logged, exported } = provision("ensure", {
      E2E_DATABASE_URL: overrideUrl("ep-healthy"),
      DEAD_HOST: "ep-dead",
    });
    expect(result.status).toBe(0);
    expect(logged.filter((call) => call.kind === "api")).toHaveLength(0);
    expect(logged.some((call) => call.kind === "sql" && call.query === "SELECT 1")).toBe(true);
    expect(exported).toContain(`E2E_DATABASE_URL=${overrideUrl("ep-healthy")}`);
    expect(exported).not.toContain("NEON_BRANCH_ID");
  });

  it("provisions a fresh branch when the override is unreachable", () => {
    const { result, logged, exported } = provision("ensure", {
      E2E_DATABASE_URL: overrideUrl("ep-dead"),
      DEAD_HOST: "ep-dead",
      STALE_BRANCHES: JSON.stringify([{ id: "br-stale", name: "ci-e2e-run-999" }]),
    });
    expect(result.status).toBe(0);

    const apiCalls = logged.filter((call) => call.kind === "api");
    expect(apiCalls.some((call) => call.method === "DELETE" && call.path?.includes("/branches/br-stale"))).toBe(true);
    const create = apiCalls.find((call) => call.method === "POST" && call.path?.endsWith("/branches"));
    expect(create?.body).toMatchObject({
      branch: { name: "ci-e2e-run-12345", parent_id: "br-parent" },
      endpoints: [{ type: "read_write" }],
    });
    const uri = apiCalls.find((call) => call.path?.includes("/connection_uri"));
    expect(uri?.path).toContain("branch_id=br-new");
    expect(uri?.path).toContain("database_name=neondb");
    expect(uri?.path).toContain("role_name=neondb_owner");

    const statements = logged.filter((call) => call.kind === "sql").map((call) => call.query);
    expect(statements[0]).toBe("SELECT 1");
    expect(statements).toContain("DROP SCHEMA public CASCADE");
    expect(statements).toContain("CREATE SCHEMA public");

    expect(exported).toContain(`E2E_DATABASE_URL=${provisionedUrl}`);
    expect(exported).toContain("NEON_BRANCH_ID=br-new");
    expect(result.stdout).toContain(`::add-mask::${provisionedUrl}`);
  });

  it("fails when the override is gone and no Neon API key is available", () => {
    const { result, logged } = provision("ensure", {
      E2E_DATABASE_URL: overrideUrl("ep-dead"),
      DEAD_HOST: "ep-dead",
      NEON_API_KEY: "",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEON_API_KEY");
    // The only work done before bailing out is the failed override probe.
    expect(logged.filter((call) => call.kind === "api")).toHaveLength(0);
    expect(logged.filter((call) => call.kind === "sql").map((call) => call.query)).toEqual(["SELECT 1"]);
  });

  it("deletes the created branch in teardown mode", () => {
    const { result, logged } = provision("teardown", { NEON_BRANCH_ID: "br-new" });
    expect(result.status).toBe(0);
    expect(logged.some((call) => call.method === "DELETE" && call.path?.includes("/branches/br-new"))).toBe(true);
  });

  it("teardown is a no-op without a branch to delete", () => {
    const { result, logged } = provision("teardown", { NEON_BRANCH_ID: "" });
    expect(result.status).toBe(0);
    expect(logged).toHaveLength(0);
  });

  it("teardown only warns when the API fails", () => {
    const { result, logged } = provision("teardown", {
      NEON_BRANCH_ID: "br-new",
      API_FAIL_ON: "/branches/br-new",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(logged.some((call) => call.method === "DELETE")).toBe(true);
  });
});
