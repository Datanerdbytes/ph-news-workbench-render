import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("hands off only ciphertext and rejects opening it in a different workflow run", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-handoff-"));
  const output = join(dir, "output");
  const environment = join(dir, "env");
  const uri = "postgresql://test:synthetic-db-password@ep-test.example.test/neondb";
  const execute = (mode: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/e2e-db-handoff.mjs", mode], {
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

  try {
    const sealed = execute("encrypt", { E2E_DATABASE_URL: uri });
    expect(sealed.status).toBe(0);
    expect(sealed.stdout).not.toContain(uri);
    const exported = readFileSync(output, "utf8");
    expect(exported).not.toContain("synthetic-db-password");
    const envelope = exported.trim().replace(/^envelope=/, "");
    expect(envelope).toMatch(/^[\w-]+$/);

    const mismatched = execute("decrypt", { E2E_DB_ENVELOPE: envelope, GITHUB_RUN_ID: "101" });
    expect(mismatched.status).toBe(1);
    expect(existsSync(environment)).toBe(false);
    expect(mismatched.stderr).not.toContain(uri);

    const opened = execute("decrypt", { E2E_DB_ENVELOPE: envelope });
    expect(opened.status).toBe(0);
    expect(opened.stdout).toContain(`::add-mask::${uri}`);
    expect(readFileSync(environment, "utf8")).toBe(`E2E_DATABASE_URL=${uri}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
