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
    CREATE INDEX CONCURRENTLY IF NOT EXISTS news_items_workspace_published_idx
    ON news_items (workspace_id, published_at DESC, id DESC)`;

  const [index] = await sql`
    SELECT indisvalid
    FROM pg_index
    WHERE indexrelid = 'news_items_workspace_published_idx'::regclass`;
  if (!index?.indisvalid) {
    throw new Error(
      'Index build was interrupted. Run DROP INDEX CONCURRENTLY news_items_workspace_published_idx, then rerun this migration.',
    );
  }

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
