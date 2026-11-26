/**
 * Plain-text sources for draft prompts. A story's text comes from wherever
 * there is the most of it: the feed (news_items.summary + raw_payload) or,
 * when the feed publishes only a lede, the article's own page.
 */

/** Draft prompts carry at most this much source text (≈1k tokens). */
export const SOURCE_MAX_CHARS = 4000;

/** Below this the feed is treated as a lede and the article page is tried. */
export const FEED_TEXT_ENOUGH_CHARS = 1000;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
};

function decodeCodePoint(value: number, original: string): string {
  // Leave malformed or out-of-range references as they are.
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : original;
}

type Tag = {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
};

function isNameStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function isNameChar(char: string): boolean {
  return isNameStart(char) || (char >= '0' && char <= '9') || char === ':' || char === '-';
}

/**
 * Linear tag tokenizer. Regex block scans backtrack badly on hostile markup —
 * a run of "<" with no ">" turns `/<[^>]+>/g` quadratic, and an unclosed
 * `<script>` or `<p>` makes every opener scan to the end of the page. Walking
 * the string once keeps extraction bounded by the page size.
 */
function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  let index = 0;

  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start === -1) break;

    const next = html[start + 1];
    if (next === '!') {
      // Comment, doctype, or CDATA: not a story tag.
      if (html.startsWith('<!--', start)) {
        const close = html.indexOf('-->', start + 4);
        index = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf('>', start + 2);
        index = close === -1 ? html.length : close + 1;
      }
      continue;
    }
    if (next === '?') {
      const close = html.indexOf('>', start + 2);
      index = close === -1 ? html.length : close + 1;
      continue;
    }

    let cursor = start + 1;
    const closing = html[cursor] === '/';
    if (closing) cursor++;
    if (!isNameStart(html[cursor] ?? '')) {
      index = start + 1;
      continue;
    }
    const nameStart = cursor;
    while (cursor < html.length && isNameChar(html[cursor])) cursor++;
    const name = html.slice(nameStart, cursor).toLowerCase();

    // A ">" inside a quoted attribute does not end the tag.
    let quote: string | null = null;
    let end = cursor;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (end >= html.length) break; // unclosed tag: nothing after it is markup

    tags.push({
      name,
      closing,
      selfClosing: html[end - 1] === '/',
      start,
      end: end + 1,
    });
    index = end + 1;
  }

  return tags;
}

/** Index of the tag that closes the opener at `openIndex`, or -1. */
function findClosingTag(tags: Tag[], openIndex: number): number {
  const { name } = tags[openIndex];
  let depth = 1;

  for (let i = openIndex + 1; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.name !== name) continue;
    if (tag.closing) {
      depth--;
      if (depth === 0) return i;
    } else if (!tag.selfClosing) {
      depth++;
    }
  }

  return -1;
}

/** Inner HTML of every closed `name` block, in document order. */
function blocksOf(html: string, tags: Tag[], name: string): string[] {
  const blocks: string[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.closing || tag.selfClosing || tag.name !== name) continue;
    const close = findClosingTag(tags, i);
    if (close === -1) continue; // an unclosed opener is not a block
    blocks.push(html.slice(tag.end, tags[close].start));
    i = close;
  }

  return blocks;
}

type Range = [number, number];

function removeRanges(html: string, ranges: Range[]): string {
  if (!ranges.length) return html;
  ranges.sort((a, b) => a[0] - b[0]);

  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start > cursor) out += html.slice(cursor, start);
    // Keep the words on either side of a removed block apart.
    out += ' ';
    cursor = end;
  }

  return out + html.slice(cursor);
}

function removeBlocks(
  html: string,
  tags: Tag[],
  matches: (tag: Tag, html: string) => boolean,
  unclosedToEnd: boolean
): string {
  const ranges: Range[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.closing || tag.selfClosing || !matches(tag, html)) continue;
    const close = findClosingTag(tags, i);
    if (close === -1) {
      if (unclosedToEnd) ranges.push([tag.start, html.length]);
      continue;
    }
    ranges.push([tag.start, tags[close].end]);
    i = close;
  }

  return removeRanges(html, ranges);
}

const NON_CONTENT_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
]);

const isNonContent = (tag: Tag) => NON_CONTENT_TAGS.has(tag.name);

// Embedded posts quote readers, not the story.
const SOCIAL_CLASS =
  /class\s*=\s*["'][^"']*(?:twitter-tweet|instagram-media|fb-(?:post|video|xfbml-parse-ignore))[^"']*["']/i;

function isSocialEmbed(tag: Tag, html: string): boolean {
  return (
    tag.name === 'blockquote' &&
    SOCIAL_CLASS.test(html.slice(tag.start, tag.end))
  );
}

/** Strip tags, decode entities, and collapse whitespace. */
export function htmlToPlainText(html: string): string {
  const withoutNonContent = removeBlocks(html, scanTags(html), isNonContent, true);
  return withoutNonContent
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) =>
      decodeCodePoint(parseInt(hex, 16), `&#x${hex};`)
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      decodeCodePoint(Number(decimal), `&#${decimal};`)
    )
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Do not end mid-word.
  return text.slice(0, maxChars).replace(/\s+\S*$/, '').trim();
}

const BODY_KEYS = ['content:encoded', 'content', 'description', 'summary'] as const;

/**
 * Longest plain-text body in a parsed RSS item. Feeds that put the whole
 * article in content:encoded — or Atom <content> — keep it only here, in
 * news_items.raw_payload, next to a much shorter description.
 */
export function articleBodyText(rawPayload: unknown, maxChars = SOURCE_MAX_CHARS): string {
  if (!rawPayload || typeof rawPayload !== 'object') return '';
  const item = rawPayload as Record<string, unknown>;

  let longest = '';
  for (const key of BODY_KEYS) {
    const value = item[key];
    if (typeof value !== 'string') continue;
    const text = htmlToPlainText(value);
    if (text.length > longest.length) longest = text;
  }

  return truncate(longest, maxChars);
}

/**
 * The most text the feed itself provides for a story. The summary column is
 * the stripped <description> — rss-parser does not truncate it — so it is the
 * whole article when the feed publishes in full there.
 */
export function feedText(
  summary: string | null | undefined,
  rawPayload: unknown,
  maxChars = SOURCE_MAX_CHARS
): string {
  const fromSummary = truncate((summary ?? '').replace(/\s+/g, ' ').trim(), maxChars);
  const fromPayload = articleBodyText(rawPayload, maxChars);
  // On a tie they are the same text, and the column has the fuller entity decoding.
  return fromSummary.length >= fromPayload.length ? fromSummary : fromPayload;
}

// Disclaimers of a site's machine-written summary widget, and other furniture.
const BOILERPLATE =
  /^(?:(?:this|the selection above) is AI-generated|related (?:stories|articles)|read more|advertisement|subscribe|sign up|follow us|share this|discover more|comments?|tags:)\b/i;
// Teaser cards use <article> too; follow the tag only when one block holds a story.
const MIN_ARTICLE_CHARS = 1000;
const STRONG_PARAGRAPH_CHARS = 60;
const MAX_WEAK_GAP = 2;

/**
 * The consecutive stretch of substantial paragraphs carrying the most text.
 * Side columns and footer promos are made of the same <p> tags as the story,
 * but not as one unbroken run of them.
 */
function longestParagraphRun(paragraphs: string[]): string {
  let best: string[] = [];
  let bestChars = 0;
  let run: string[] = [];
  let runChars = 0;
  let gap = 0;

  const closeRun = () => {
    if (runChars > bestChars) {
      best = run;
      bestChars = runChars;
    }
    run = [];
    runChars = 0;
    gap = 0;
  };

  for (const text of paragraphs) {
    if (text.length >= STRONG_PARAGRAPH_CHARS) {
      run.push(text);
      runChars += text.length;
      gap = 0;
    } else if (run.length && ++gap <= MAX_WEAK_GAP) {
      // A short quote or byline inside the story is kept with it.
      run.push(text);
    } else {
      closeRun();
    }
  }
  closeRun();

  return best.join('\n\n');
}

/**
 * Article text from a story's own HTML page, for feeds that publish only a
 * lede. Returns '' when the markup holds no readable run of paragraphs, so
 * callers can fall back to the feed text.
 */
function paragraphsOf(html: string): string[] {
  return blocksOf(html, scanTags(html), 'p')
    .map((block) => htmlToPlainText(block))
    .filter((text) => text && !BOILERPLATE.test(text));
}

export function extractArticleText(html: string, maxChars = SOURCE_MAX_CHARS): string {
  const withoutNonContent = removeBlocks(
    html,
    scanTags(html),
    isNonContent,
    true
  );
  const page = removeBlocks(
    withoutNonContent,
    scanTags(withoutNonContent),
    isSocialEmbed,
    false
  );
  const pageTags = scanTags(page);
  const articles = blocksOf(page, pageTags, 'article');

  // One <article> holding a story is the page. Teaser-sized ones are kept
  // apart from the rest instead of dropped: a short story also lives in one,
  // and losing it costs more than a stray teaser line.
  let scopes = [page];
  if (articles.length) {
    const main = articles.reduce((a, b) => (b.length > a.length ? b : a));
    scopes =
      htmlToPlainText(main).length >= MIN_ARTICLE_CHARS
        ? [main]
        : [
            removeBlocks(page, pageTags, (tag) => tag.name === 'article', false),
            ...articles,
          ];
  }

  const text = scopes
    .map((scope) => longestParagraphRun(paragraphsOf(scope)))
    .reduce((best, run) => (run.length > best.length ? run : best), '');

  return truncate(text, maxChars);
}

/** Page text wins only when it clearly adds to the feed's own text. */
export function richerText(feed: string, page: string): string {
  return page.length >= 500 && page.length >= feed.length + 300 ? page : feed;
}
