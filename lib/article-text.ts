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

/** Strip tags, decode entities, and collapse whitespace. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
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

const NON_CONTENT = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Embedded posts quote readers, not the story.
const SOCIAL_EMBEDS =
  /<blockquote\b[^>]*\bclass\s*=\s*["'][^"']*(?:twitter-tweet|instagram-media|fb-(?:post|video|xfbml-parse-ignore))[^"']*["'][^>]*>[\s\S]*?<\/blockquote>/gi;
const ARTICLE = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi;
const PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
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
  return [...html.matchAll(PARAGRAPH)]
    .map((match) => htmlToPlainText(match[1]))
    .filter((text) => text && !BOILERPLATE.test(text));
}

export function extractArticleText(html: string, maxChars = SOURCE_MAX_CHARS): string {
  const page = html.replace(NON_CONTENT, ' ').replace(SOCIAL_EMBEDS, ' ');

  // One <article> holding a story is the page. Teaser-sized ones are kept
  // apart from the rest instead of dropped: a short story also lives in one,
  // and losing it costs more than a stray teaser line.
  const articles = [...page.matchAll(ARTICLE)];
  let scopes = [page];
  if (articles.length) {
    const main = articles.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    scopes =
      htmlToPlainText(main[1]).length >= MIN_ARTICLE_CHARS
        ? [main[1]]
        : [page.replace(ARTICLE, ' '), ...articles.map((match) => match[1])];
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
