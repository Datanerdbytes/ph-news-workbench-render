import { neon } from '@neondatabase/serverless';

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

function toAbsoluteImageUrl(url, base) {
  const cleaned = url
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&apos;/gi, "'");
  if (!cleaned || /^data:|^blob:|^javascript:/i.test(cleaned)) return null;
  try {
    const resolved = new URL(cleaned, base ?? undefined);
    return /^https?:\/\//i.test(resolved.toString()) ? resolved.toString() : null;
  } catch {
    return null;
  }
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

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

migrate().catch(console.error);
