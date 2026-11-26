import { ARTICLE_HEADERS, fetchPublicDocument } from './article-image';
import { extractArticleText } from './article-text';

const ARTICLE_TIMEOUT_MS = 8_000;
// Article pages run 100 KB to 1 MB of markup, and the body often sits after
// the navigation and ad slots.
const ARTICLE_MAX_BYTES = 1_500_000;

/**
 * The article text from a story's own page, for feeds that publish only a
 * lede. Best-effort: a site that refuses the request, a response that is not
 * HTML, or markup the extractor cannot read all resolve to '' so the caller
 * keeps the feed text. Every hop goes through the public-source policy, the
 * same path the og:image lookup takes for these URLs at ingest.
 */
export async function fetchArticleText(url: string): Promise<string> {
  try {
    const doc = await fetchPublicDocument(url, {
      headers: ARTICLE_HEADERS,
      timeoutMs: ARTICLE_TIMEOUT_MS,
      maxBytes: ARTICLE_MAX_BYTES,
      acceptContentTypes: /text\/html/i,
    });
    return !doc || doc.status >= 400 ? '' : extractArticleText(doc.text);
  } catch {
    // A page that cannot be read is no source at all.
    return '';
  }
}
