import { neon } from '@neondatabase/serverless';
import { fetchArticleImage, toAbsoluteImageUrl } from './lib/article-image.ts';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const sql = neon(process.env.DATABASE_URL);

// Self-contained copy of lib/feeds.ts#extractItemImage (the migration runs as
// plain .mjs and cannot import the TS lib). Keep the two in sync.
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|jfif)(?:[?#]|$)/i;

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : value !== undefined && value !== null ? [value] : [];
}

function xmlAttrs(node) {
  return asRecord(asRecord(node)?.$);
}

function looksLikeImageUrl(url, attrs) {
  const type = typeof attrs?.type === 'string' ? attrs.type : '';
  if (type.startsWith('image/')) return true;
  if (attrs?.medium === 'image') return true;
  return IMAGE_EXT_RE.test(url);
}

function firstHtmlImage(html, base) {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = match[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!src) continue;
    const resolved = toAbsoluteImageUrl(src, base);
    if (resolved) return resolved;
  }
  return null;
}

function collectMediaUrls(nodes, thumbnailOnly, base) {
  for (const node of nodes) {
    const attrs = xmlAttrs(node);
    const url = typeof attrs?.url === 'string' ? attrs.url : null;
    if (!url) continue;
    if (!thumbnailOnly && !looksLikeImageUrl(url, attrs)) continue;
    const resolved = toAbsoluteImageUrl(url, base);
    if (resolved) return resolved;
  }
  return null;
}

function extractItemImage(payload) {
  const item = asRecord(payload);
  if (!item) return null;
  const base = typeof item.link === 'string' && item.link ? item.link : null;

  const enclosure = asRecord(item.enclosure);
  if (enclosure && typeof enclosure.url === 'string' && looksLikeImageUrl(enclosure.url, enclosure)) {
    const resolved = toAbsoluteImageUrl(enclosure.url, base);
    if (resolved) return resolved;
  }

  const fromMediaTags =
    collectMediaUrls(asArray(item['media:content']), false, base) ??
    collectMediaUrls(asArray(item['media:thumbnail']), true, base);
  if (fromMediaTags) return fromMediaTags;

  for (const group of asArray(item['media:group'])) {
    const rec = asRecord(group);
    if (!rec) continue;
    const nested =
      collectMediaUrls(asArray(rec['media:content']), false, base) ??
      collectMediaUrls(asArray(rec['media:thumbnail']), true, base);
    if (nested) return nested;
  }

  for (const key of ['content:encoded', 'content', 'summary']) {
    if (typeof item[key] !== 'string') continue;
    const resolved = firstHtmlImage(item[key], base);
    if (resolved) return resolved;
  }

  return null;
}

const OG_CONCURRENCY = 8;

async function migrate() {
  console.log('Starting sources redesign migration...');

  try {
    // 1. feeds.category — optional grouping for the redesigned Sources sidebar
    console.log('Adding feeds.category...');
    await sql`ALTER TABLE feeds ADD COLUMN IF NOT EXISTS category TEXT`;

    // 2. news_items.image_url — thumbnail extracted at ingest
    console.log('Adding news_items.image_url...');
    await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_url TEXT`;

    // 3. Backfill thumbnails from the raw payloads already stored. Older rows
    // were parsed before media:content was preserved (see feedParser
    // customFields), so this mostly mines enclosures and <img> content HTML.
    console.log('Backfilling news_items.image_url from raw_payload...');
    const rows = await sql`
      SELECT id, raw_payload FROM news_items
      WHERE image_url IS NULL AND raw_payload IS NOT NULL
    `;
    let backfilled = 0;
    for (const row of rows) {
      let payload = row.raw_payload;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          continue;
        }
      }
      const imageUrl = extractItemImage(payload);
      if (!imageUrl) continue;
      await sql`UPDATE news_items SET image_url = ${imageUrl} WHERE id = ${row.id}`;
      backfilled++;
    }
    console.log(`Backfilled ${backfilled} of ${rows.length} rows`);

    // 4. Stories still without a thumbnail get one bounded og:image lookup of
    // their own page, batched in parallel. Never throws per row; a blocked or
    // image-less page simply stays with the monogram fallback.
    console.log('Fetching og:image for stories without thumbnails...');
    const ogRows = await sql`
      SELECT id, link FROM news_items
      WHERE image_url IS NULL AND link <> ''
    `;
    let ogFilled = 0;
    for (let start = 0; start < ogRows.length; start += OG_CONCURRENCY) {
      const batch = ogRows.slice(start, start + OG_CONCURRENCY);
      await Promise.all(batch.map(async row => {
        const image = await fetchArticleImage(row.link);
        if (!image) return;
        await sql`UPDATE news_items SET image_url = ${image} WHERE id = ${row.id}`;
        ogFilled++;
      }));
    }
    console.log(`og:image filled ${ogFilled} of ${ogRows.length} rows`);

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
