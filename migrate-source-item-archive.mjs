import { config } from 'dotenv';

config();
config({ path: '.env.local' });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const { neon } = await import('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function main() {
  await sql`
    CREATE INDEX IF NOT EXISTS news_items_workspace_published_idx
    ON news_items (workspace_id, published_at DESC, id DESC)`;

  console.log(JSON.stringify({
    migration: 'source-item-archive',
    event: 'done',
  }));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
