import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "prepare-e2e-test-"));
const preload = join(scratch, "fetch-stub.mjs");
const queries = join(scratch, "queries.jsonl");

// Exercise the real Neon client in the parent and migration subprocesses,
// with a synthetic HTTP endpoint so no database or credentials are used.
writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (_url, options) => {
  const { query } = JSON.parse(options.body);
  appendFileSync(process.env.QUERY_LOG, JSON.stringify(query) + '\\n');
  if (query.includes(process.env.FAIL_ON)) {
    return new Response(JSON.stringify({ message: 'synthetic database failure' }), { status: 400 });
  }
  return new Response(JSON.stringify({ fields: [], rows: [] }), { status: 200 });
};
`);

afterEach(() => rmSync(queries, { force: true }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function prepare(failOn: string) {
  const result = spawnSync(process.execPath, ["scripts/prepare-e2e-db.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${preload}`,
      DATABASE_URL: "postgresql://test:test@example.test/test",
      OWNER_EMAIL: "owner@example.test",
      OWNER_PASSWORD: "test-password",
      BETTER_AUTH_SECRET: "test-secret",
      QUERY_LOG: queries,
      FAIL_ON: failOn,
    },
  });
  const statements = readFileSync(queries, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string);
  return { result, statements };
}

describe("E2E database preparation", () => {
  it("executes authentication and base schema DDL before seeding the owner", () => {
    const { result, statements } = prepare('INSERT INTO "user"');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("synthetic database failure");
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS "user"');
    expect(statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS workspaces"))).toBe(true);
    expect(statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS download_jobs"))).toBe(true);
    expect(statements.at(-1)).toContain('INSERT INTO "user"');
  });

  it("stops when authentication schema creation fails", () => {
    const { result, statements } = prepare('CREATE TABLE IF NOT EXISTS "user"');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("synthetic database failure");
    expect(statements).toHaveLength(1);
  });

  it("stops when base schema creation fails", () => {
    const { result, statements } = prepare("CREATE TABLE IF NOT EXISTS workspaces");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("synthetic database failure");
    expect(statements.at(-1)).toContain("CREATE TABLE IF NOT EXISTS workspaces");
    expect(statements.some((sql) => sql.includes('INSERT INTO "user"'))).toBe(false);
  });
});
