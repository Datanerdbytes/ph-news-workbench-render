// Preload for local development — routes the neon serverless driver at the
// local docker Postgres (phnews-pg) instead of Neon's cloud:
//   NODE_OPTIONS="--import ./scripts/neon-local.mjs" node --env-file=.env.local <script>
//   NODE_OPTIONS="--import ./scripts/neon-local.mjs" npm run dev
//
// Only activates for local DATABASE_URL hosts; production is untouched.
// `neon()` (and drizzle's neon-http driver on top of it) speaks Neon's HTTP
// /sql protocol, which a vanilla Postgres has no endpoint for. fetchFunction
// intercepts those calls, executes them through a WebSocket Pool tunneled by
// the phnews-wsproxy container, and answers in the same JSON shape Neon's
// API returns (raw-text rows, re-parsed by the driver exactly as in prod).
//
// The package ships separate ESM and CJS builds with independent
// neonConfig statics, so both instances get the same configuration —
// repo scripts use require() while the app imports it as ESM.
import { neonConfig, Pool } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// The preload runs before Next has loaded .env.local, so fall back to
// reading the file directly — but never let a missing file kill the host
// process; a preload failure aborts Node before any code runs.
let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  try {
    dbUrl =
      readFileSync(new URL("../.env.local", import.meta.url), "utf8")
        .split("\n")
        .find((line) => line.startsWith("DATABASE_URL="))
        ?.slice("DATABASE_URL=".length)
        .trim() ?? undefined;
  } catch {
    // No .env.local — leave the driver untouched below.
  }
}

const host = dbUrl ? new URL(dbUrl).hostname : "";
const isLocal = host === "postgres" || host === "localhost";

if (isLocal) {
  neonConfig.wsProxy = (h, port) => `localhost:5434/v1?address=${h}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  // Vanilla Postgres negotiates SCRAM itself; no Neon-style pipelined auth.
  neonConfig.pipelineConnect = "";

  // Identity type parsers keep every value as Postgres TEXT; the neon HTTP
  // layer re-parses them with the real per-column parsers, so results match
  // production byte-for-byte.
  const pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    types: { getTypeParser: () => (v) => v },
  });

  const runOne = async ({ query, params }) => {
    const res = await pool.query({
      text: query,
      values: params ?? [],
      rowMode: "array",
    });
    return {
      fields: res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: res.rows,
    };
  };

  const fetchFunction = async (_url, options) => {
    const body = JSON.parse(options.body);
    try {
      if (Array.isArray(body.queries)) {
        // sql.transaction([...]) — one implicit transaction, like Neon's API.
        const client = await pool.connect();
        const results = [];
        try {
          await client.query("BEGIN");
          for (const q of body.queries) results.push(await runOne(q));
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      return new Response(JSON.stringify(await runOne(body)), { status: 200 });
    } catch (error) {
      return new Response(
        JSON.stringify({ message: error?.message ?? String(error) }),
        { status: 400 },
      );
    }
  };

  const cjs = createRequire(import.meta.url)("@neondatabase/serverless");
  const cjsConfig = cjs.neonConfig;
  cjsConfig.wsProxy = neonConfig.wsProxy;
  cjsConfig.useSecureWebSocket = false;
  cjsConfig.forceDisablePgSSL = true;
  cjsConfig.pipelineConnect = "";
  cjsConfig.fetchFunction = fetchFunction;
  neonConfig.fetchFunction = fetchFunction;

  // NOTE: bare `await sql.unsafe(stmt)` never executes on the HTTP driver —
  // it returns an inert composable fragment — and this build exposes `neon`
  // as a read-only getter, so it cannot be patched here either. CJS scripts
  // that rely on it (migrate-auth.js) must have their statements applied out
  // of band, e.g. via psql.
}
