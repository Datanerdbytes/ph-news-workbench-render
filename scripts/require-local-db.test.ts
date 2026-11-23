import { describe, expect, it } from "vitest";
import { checkDatabaseUrl, refusalMessage } from "./require-local-db.mjs";

const LOCAL = [
  "postgresql://neondb_owner:pw@postgres:5432/phnews?sslmode=disable",
  "postgresql://neondb_owner:pw@localhost:5432/phnews",
  "postgresql://neondb_owner:pw@127.0.0.1:5432/phnews",
  "postgresql://neondb_owner:pw@[::1]:5432/phnews",
];

describe("checkDatabaseUrl", () => {
  it("accepts the Docker Postgres hosts", () => {
    for (const url of LOCAL) {
      expect(checkDatabaseUrl(url)).toMatchObject({ ok: true });
    }
  });

  it("refuses a remote database, naming its host", () => {
    const result = checkDatabaseUrl(
      "postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/phnews?sslmode=require",
    );
    expect(result).toEqual({
      ok: false,
      reason: "remote",
      host: "ep-cool-123.us-east-2.aws.neon.tech",
    });
    expect(refusalMessage(result)).toContain("ep-cool-123.us-east-2.aws.neon.tech");
  });

  it("treats a missing value as missing rather than remote", () => {
    expect(checkDatabaseUrl(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(checkDatabaseUrl("")).toEqual({ ok: false, reason: "missing" });
    expect(refusalMessage(checkDatabaseUrl(""))).toContain("DATABASE_URL is not set");
  });

  it("refuses a value that is not a URL", () => {
    const result = checkDatabaseUrl("not-a-url");
    expect(result).toEqual({ ok: false, reason: "unparseable" });
    expect(refusalMessage(result)).toContain("not a parseable URL");
  });
});
