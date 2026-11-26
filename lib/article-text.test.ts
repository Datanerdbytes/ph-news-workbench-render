import { describe, expect, it } from "vitest";
import {
  articleBodyText,
  extractArticleText,
  feedText,
  htmlToPlainText,
  richerText,
  SOURCE_MAX_CHARS,
} from "./article-text";

// A paragraph long enough to count as story text.
const p = (index: number) =>
  `<p>Paragraph ${index}: ${"a detail from the news story. ".repeat(4)}</p>`;
const paras = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => p(from + i)).join("\n");
const LEDE =
  "The Department of Transportation said on Tuesday it would review the supply and demand of public utility vehicles nationwide.";

describe("htmlToPlainText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(
      htmlToPlainText("<p>Storm  <b>Signal No. 3</b>   raised.</p>\n<p>More rain.</p>")
    ).toBe("Storm Signal No. 3 raised. More rain.");
  });

  it("drops script and style blocks entirely", () => {
    expect(
      htmlToPlainText("<style>p{color:red}</style>Before<script>evil()</script>After")
    ).toBe("Before After");
  });

  it("decodes named and numeric entities", () => {
    expect(
      htmlToPlainText("P5&nbsp;billion &quot;aid&quot; &amp; &#39;relief&#39; &mdash; Quezon City&rsquo;s &#8369;20M &#x00A9; 2026")
    ).toBe(`P5 billion "aid" & 'relief' — Quezon City’s ₱20M © 2026`);
  });

  it("leaves unknown or malformed entities untouched", () => {
    expect(htmlToPlainText("&bogus; &#9999999999; a &lt b")).toBe(
      "&bogus; &#9999999999; a &lt b"
    );
  });
});

describe("articleBodyText", () => {
  it("prefers the longest field, including content:encoded", () => {
    const payload = {
      description: "<p>Short snippet.</p>",
      "content:encoded": "<p>Full article body with all the context.</p>",
    };
    expect(articleBodyText(payload)).toBe(
      "Full article body with all the context."
    );
  });

  it("returns '' for missing or malformed payloads", () => {
    expect(articleBodyText(null)).toBe("");
    expect(articleBodyText(undefined)).toBe("");
    expect(articleBodyText("not-an-object")).toBe("");
    expect(articleBodyText({})).toBe("");
  });

  it("truncates long bodies at a word boundary", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const text = articleBodyText({ "content:encoded": `<p>${words}</p>` }, 100);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.split(" ").every((w) => /^word\d+$/.test(w))).toBe(true);
  });
});

describe("feedText", () => {
  const detail = "Follow-up detail. ".repeat(40).trim();
  const article = `${LEDE} ${detail}`;

  it("uses the summary when the description holds the whole article", () => {
    expect(
      feedText(article, { content: `<p>${article}</p>`, contentSnippet: article })
    ).toBe(article);
  });

  it("takes the article from the payload when the feed published only a lede", () => {
    const payload = {
      content: `<p>${LEDE}</p>`,
      contentSnippet: LEDE,
      "content:encoded": `<p>&ldquo;${article}&rdquo;</p>`,
    };
    expect(feedText(LEDE, payload)).toBe(`“${article}”`);
  });

  it("falls back to the summary column when there is no payload", () => {
    expect(feedText(`${LEDE}\n${LEDE}`, null)).toBe(`${LEDE} ${LEDE}`);
    expect(feedText(null, null)).toBe("");
  });

  it("caps the source length", () => {
    const long = `${LEDE} `.repeat(400);
    expect(feedText(long, null).length).toBeLessThanOrEqual(SOURCE_MAX_CHARS);
    expect(feedText(long, null).length).toBeGreaterThan(3000);
  });
});

describe("extractArticleText", () => {
  it("reads the paragraphs of a page without an <article> tag", () => {
    const html = `<html><body><nav><a>Menu</a></nav>${paras(0, 5)}<footer>© 2026</footer></body></html>`;
    const text = extractArticleText(html);
    expect(text.split("\n\n")).toHaveLength(5);
    expect(text).toContain("Paragraph 0: a detail from the news story.");
  });

  it("scopes to the one <article> that holds the story, not the teaser cards", () => {
    const html = `<body>
      <article><p>${"Teaser one. ".repeat(10)}</p></article>
      <article><p>${"Teaser two. ".repeat(10)}</p></article>
      <article>${paras(0, 12)}</article>
    </body>`;
    const text = extractArticleText(html);
    expect(text.split("\n\n")).toHaveLength(12);
    expect(text).toContain("Paragraph 11:");
    expect(text).not.toContain("Teaser");
  });

  it("keeps teaser cards apart from a story that is not wrapped in <article>", () => {
    const html = `<body><article><p>${"Teaser card. ".repeat(10)}</p></article>${paras(0, 6)}</body>`;
    const text = extractArticleText(html);
    expect(text).toContain("Paragraph 5:");
    expect(text).not.toContain("Teaser");
  });

  it("still reads a short story that lives in its own <article>", () => {
    const html = `<body><header><p>${"Site masthead text. ".repeat(10)}</p></header><article>${paras(0, 4)}</article></body>`;
    const text = extractArticleText(html);
    expect(text).toContain("Paragraph 3:");
    expect(text).not.toContain("Site masthead");
  });

  it("drops scripts, styles, and embedded social posts", () => {
    const tweet = `<blockquote class="twitter-tweet"><p dir="ltr">${"A reader reacting to the news. ".repeat(5)}</p>&mdash; Reader (@reader)</blockquote>`;
    const html = `<article>
      <script>var markup = "<p>${"Not a paragraph. ".repeat(10)}</p>";</script>
      <style>.story { color: red; }</style>
      ${paras(0, 2)}${tweet}${paras(2, 2)}
    </article>`;
    const text = extractArticleText(html);
    expect(text.split("\n\n")).toEqual(
      [0, 1, 2, 3].map((i) =>
        expect.stringContaining(`Paragraph ${i}:`)
      )
    );
    expect(text).not.toContain("reader reacting");
    expect(text).not.toContain("Not a paragraph");
  });

  it("keeps the longest run of paragraphs and skips side content", () => {
    const gap = "<p>Menu item.</p>".repeat(3);
    const html = `<body>
      <aside>${paras(0, 2)}</aside>
      ${gap}
      <main>${p(2)}<p>&ldquo;A short quote.&rdquo;</p>${paras(3, 4)}</main>
    </body>`;
    const text = extractArticleText(html);
    expect(text).toContain("Paragraph 6:");
    expect(text).toContain("“A short quote.”");
    expect(text).not.toContain("Paragraph 0:");
    expect(text).not.toContain("Paragraph 1:");
  });

  it("drops boilerplate lines", () => {
    const html = `<body>${p(0)}
      <p>Related Stories: ${"Headline ".repeat(12)}</p>
      <p>Subscribe to our newsletter ${"now ".repeat(20)}</p>
      <p>This is AI-generated. Read the article for full context.</p>
      <p>The selection above is AI-generated. Read the article for full context.</p>
      ${p(1)}</body>`;
    const text = extractArticleText(html);
    expect(text).not.toContain("Related Stories");
    expect(text).not.toContain("Subscribe");
    expect(text).not.toContain("AI-generated");
    expect(text).toContain("Paragraph 1:");
  });

  it("truncates at a word boundary", () => {
    const html = `<body>${paras(0, 40)}</body>`;
    const full = extractArticleText(html);
    // Pick a limit that falls inside a word rather than on a space.
    const cut = [...full].findIndex(
      (char, i) => i > 40 && char !== " " && full[i - 1] !== " "
    );
    const text = extractArticleText(html, cut);
    expect(full.slice(0, cut)).toMatch(/\S\w$/);
    // The partial word is dropped, everything before it is kept.
    expect(text).toBe(full.slice(0, cut).replace(/\s+\S*$/, ""));
    expect(text.length).toBeLessThan(cut);
  });

  it("returns '' when the page has no readable paragraphs", () => {
    expect(extractArticleText("<html><body><div>Just text.</div></body></html>")).toBe("");
    expect(extractArticleText("")).toBe("");
  });
});

describe("richerText", () => {
  const page = `${LEDE} ${"More reporting. ".repeat(60)}`;

  it("takes the page text when it clearly adds to the lede", () => {
    expect(richerText(LEDE, page)).toBe(page);
  });

  it("keeps the feed text when the page adds nothing usable", () => {
    expect(richerText(LEDE, "")).toBe(LEDE);
    expect(richerText(LEDE, LEDE)).toBe(LEDE);
    // Long enough on its own, but barely more than the feed already had.
    expect(richerText(page, `${page} Extra.`)).toBe(page);
  });
});
