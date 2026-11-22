import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const uri = "postgresql://test:synthetic-db-password@ep-test.example.test/neondb";

function execute(mode: string, extra: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-handoff-"));
  const output = join(dir, "output");
  const environment = join(dir, "env");
  try {
    const result = spawnSync(process.execPath, ["scripts/e2e-db-handoff.mjs", mode], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_RUN_ID: "100",
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: output,
        E2E_DB_HANDOFF_KEY: "ab".repeat(32),
        ...extra,
      },
    });
    const exported = existsSync(environment) ? readFileSync(environment, "utf8") : "";
    const rawOutput = existsSync(output) ? readFileSync(output, "utf8") : "";
    const envelope = rawOutput.trim().replace(/^envelope=/, "");
    return { result, exported, envelope };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("hands off only ciphertext and rejects opening it in a different workflow run", () => {
  const sealed = execute("encrypt", { E2E_DATABASE_URL: uri });
  expect(sealed.result.status).toBe(0);
  expect(sealed.result.stdout).not.toContain(uri);
  expect(sealed.exported).not.toContain("synthetic-db-password");
  expect(sealed.envelope).toMatch(/^[\w-]+$/);

  const mismatched = execute("decrypt", { E2E_DB_ENVELOPE: sealed.envelope, GITHUB_RUN_ID: "101" });
  expect(mismatched.result.status).toBe(1);
  expect(mismatched.exported).toBe("");
  expect(mismatched.result.stderr).not.toContain(uri);

  const opened = execute("decrypt", { E2E_DB_ENVELOPE: sealed.envelope });
  expect(opened.result.status).toBe(0);
  expect(opened.result.stdout).toContain(`::add-mask::${uri}`);
  expect(opened.exported).toBe(`E2E_DATABASE_URL=${uri}\n`);
});

it("prints validation failures but keeps failures around secret material generic", () => {
  const badKey = execute("encrypt", { E2E_DB_HANDOFF_KEY: "not-hex", E2E_DATABASE_URL: uri });
  expect(badKey.result.status).toBe(1);
  expect(badKey.result.stderr).toContain("32-byte hex key");

  const noEnvelope = execute("decrypt", { E2E_DB_ENVELOPE: "" });
  expect(noEnvelope.result.status).toBe(1);
  expect(noEnvelope.result.stderr).toContain("E2E_DB_ENVELOPE");

  const wrongKey = execute("decrypt", {
    E2E_DB_ENVELOPE: execute("encrypt", { E2E_DATABASE_URL: uri }).envelope,
    E2E_DB_HANDOFF_KEY: "cd".repeat(32),
  });
  expect(wrongKey.result.status).toBe(1);
  expect(wrongKey.result.stderr).not.toContain(uri);
  expect(wrongKey.result.stderr).toContain("failed to open");
  expect(wrongKey.result.stderr).not.toContain("synthetic-db-password");

  const missingUri = execute("encrypt", { E2E_DATABASE_URL: "" });
  expect(missingUri.result.status).toBe(1);
  expect(missingUri.result.stderr).toContain("did not set E2E_DATABASE_URL");
});
