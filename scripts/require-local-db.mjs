// Guard for `npm run test:e2e:local`.
//
// The Playwright specs write to the database at DATABASE_URL: they seed
// notifications, flip drafts, and delete rows by fixture marker. In CI that URL
// is a disposable Neon branch; locally it must be the Docker Postgres, or a
// developer's dev data becomes collateral damage.
//
// The browser target and the SQL target are chosen separately — Playwright
// reads BETTER_AUTH_URL while e2e/helpers/db.ts reads DATABASE_URL — so this
// cannot prove the two match. It can prove the database is local, which is the
// part that makes a mismatched target destructive rather than merely wrong.
//
// This is a locality check, not an identity check: an SSH tunnel that forwards
// a remote database to localhost:5432 passes. Identifying the server reliably
// would need a marker the database does not carry, so the README states the
// weaker guarantee instead of implying one that does not hold.
import { pathToFileURL } from "node:url";

const LOCAL_HOSTS = new Set(["postgres", "localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Decide whether `npm run test:e2e:local` may write to the configured database.
 * Pure so the rules can be unit tested without spawning a process.
 */
export function checkDatabaseUrl(raw) {
  if (!raw) return { ok: false, reason: "missing" };
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!LOCAL_HOSTS.has(host)) return { ok: false, reason: "remote", host };
  return { ok: true, host };
}

export function refusalMessage(result) {
  if (result.reason === "missing") {
    return (
      "test:e2e:local: DATABASE_URL is not set. Copy .env.local from the main " +
      "checkout (see README → Tests) before running the local suite."
    );
  }
  if (result.reason === "unparseable") {
    return "test:e2e:local: DATABASE_URL is not a parseable URL.";
  }
  return (
    `test:e2e:local: refusing to run — DATABASE_URL points at "${result.host}", which is not local.\n` +
    "The specs write to that database (they seed rows and delete by fixture\n" +
    "marker). Point DATABASE_URL at the Docker Postgres (host `postgres` or\n" +
    "`localhost`), or use CI's `npm run test:e2e` against a disposable branch."
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!result.ok) {
    console.error(refusalMessage(result));
    process.exit(1);
  }
}
