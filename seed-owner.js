require('dotenv').config({path:'.env.local'});
const { neon } = require('@neondatabase/serverless');
const { hashPassword } = require('better-auth/crypto');
const { randomUUID } = require('crypto');
(async () => {
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL in .env.local');
  }
  if (!email || !password) {
    throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD in .env.local');
  }
  const sql = neon(process.env.DATABASE_URL);
  const id = randomUUID();
  const hashed = await hashPassword(password);
  await sql`INSERT INTO "user" (id, name, email, email_verified) VALUES (${id}, 'QuantumEcho', ${email}, true) ON CONFLICT (email) DO NOTHING`;
  const u = await sql`SELECT id FROM "user" WHERE email=${email}`;
  const uid = u[0].id;
  // better-auth matches the credential account by account_id = user.id, not by
  // the email, and the table has no unique constraint to make a second insert
  // fail — so the old row is dropped first. Re-running this script therefore
  // resets the password instead of piling up unusable accounts. The two
  // writes share one transaction: without it a failed insert would leave the
  // owner with no credential row at all.
  await sql.transaction([
    sql`DELETE FROM account WHERE user_id = ${uid} AND provider_id = 'credential'`,
    sql`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (${randomUUID()}, ${uid}, 'credential', ${uid}, ${hashed}, now(), now())`,
  ]);
  console.log('seeded', email);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
