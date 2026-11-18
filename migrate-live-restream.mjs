import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  console.log('Adding live restream columns to live_streams...');

  await sql`
    ALTER TABLE live_streams
      ADD COLUMN IF NOT EXISTS source_url TEXT,
      ADD COLUMN IF NOT EXISTS pump_status TEXT NOT NULL DEFAULT 'idle',
      ADD COLUMN IF NOT EXISTS pump_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pump_error TEXT
  `;

  console.log('Done: live_streams.');
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
