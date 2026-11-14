require('dotenv').config({path:'.env.local'});
const { neon } = require('@neondatabase/serverless');
const { hashPassword } = require('better-auth/crypto');
const { randomUUID } = require('crypto');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) {
    throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD in .env.local');
  }
  const id = randomUUID();
  const hashed = await hashPassword(password);
  await sql`INSERT INTO "user" (id, name, email, email_verified) VALUES (${id}, 'QuantumEcho', ${email}, true) ON CONFLICT (email) DO NOTHING`;
  const u = await sql`SELECT id FROM "user" WHERE email=${email}`;
  const uid = u[0].id;
  // better-auth matches the credential account by account_id = user.id, not by
  // the email, and the table has no unique constraint to make a second insert
  // fail — so the old row is dropped first. Re-running this script therefore
  // resets the password instead of piling up unusable accounts.
  await sql`DELETE FROM account WHERE user_id = ${uid} AND provider_id = 'credential'`;
  await sql`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (${randomUUID()}, ${uid}, 'credential', ${uid}, ${hashed}, now(), now())`;
  console.log('seeded', email);
})().catch(e=>console.error(e.message));