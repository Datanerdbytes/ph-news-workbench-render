import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchArticleText } from '@/lib/article-fetch';
import { FEED_TEXT_ENOUGH_CHARS, feedText, richerText } from '@/lib/article-text';
import { draftPost, resolveTextModel } from '@/lib/openrouter';
import { requireWorkspace, unauthorized } from '@/lib/session';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  const access = await requireWorkspace(req);
  if (!access) return unauthorized();
  const { newsItemId, language } = await req.json();
  const lang = language === 'tl' ? 'Tagalog' : 'English';
  const model = resolveTextModel(access.workspace.aiModel);
  const correlationId = randomUUID();
  console.log(JSON.stringify({ route: 'draft', correlationId, event: 'start', newsItemId, model }));
  const items = await sql`SELECT title, summary, link, raw_payload FROM news_items WHERE id = ${newsItemId} AND workspace_id = ${access.workspace.id}`;
  if (!items.length) { console.log(JSON.stringify({ route: 'draft', correlationId, event: 'not_found', newsItemId })); return NextResponse.json({ error: 'not found', correlationId }, { status: 404 }); }
  const item = items[0];
  // The feed is the source when it carries the story. A feed that publishes
  // only a lede is topped up from the article page — and stays a lede when
  // the site refuses the request.
  const fed = feedText(item.summary, item.raw_payload);
  const source = fed.length >= FEED_TEXT_ENOUGH_CHARS
    ? fed
    : richerText(fed, await fetchArticleText(item.link));
  const ledeOnly = source.length < FEED_TEXT_ENOUGH_CHARS;
  // A lede cannot carry a full post: asking for one only invites padding and
  // invented detail, so the brief shrinks with the source.
  const prompt = [
    `You are writing a Facebook post for a Philippine news team. Rewrite the news story below as a short, self-contained post in ${lang}: most readers will not open the link, so the post itself has to tell the story.`,
    '',
    'How to write it:',
    '- Open with the most important fact — what happened, to whom, where. Do not just restate the headline.',
    ledeOnly
      ? '- The source is a short summary (or none), so write 2-3 sentences and stay within what it states.'
      : '- Follow with 2-3 short paragraphs. Keep the details that give the story its meaning — names, numbers, places, dates, what happens next — and drop the filler.',
    '- Plain, conversational words; short lines; no jargon. Rebuild every sentence in your own words; never copy a sentence from the source.',
    // The Tagalog draft doubles as the voice-over script, and the Filipino TTS
    // voice reads digits and Tagalog number words in Tagalog. Filipino
    // newsreaders say numbers in English, so the words have to say so.
    ...(lang === 'Tagalog'
      ? ['- Write every number as English words (five, thirty percent, two thousand twenty-four), never in Tagalog: the post is read aloud, and the voice reads English numbers most naturally.']
      : []),
    '- Use only facts stated in the source. Never invent numbers, names, quotes, or outcomes. If the source does not say it, leave it out.',
    '- Tone: informative, neutral.',
    ...(ledeOnly ? [] : ['- Keep the whole post under 120 words (about 700 characters).']),
    '',
    'Return the post text only — no preamble, no title, no surrounding quotes.',
    '',
    `Headline: ${item.title}`,
    source
      ? ledeOnly
        ? `Source text (a short summary only):\n${source}`
        : `Source text (may be cut off early):\n${source}`
      : 'No article text is available: use only the headline.',
    `Link: ${item.link}`,
  ].join('\n');
  try {
    const result = await draftPost(prompt, model);
    console.log(JSON.stringify({ route: 'draft', correlationId, event: 'drafted', newsItemId, model, servedModel: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
    await sql`
      INSERT INTO drafts (user_id, workspace_id, news_item_id, text, model, input_tokens, output_tokens, estimated_cost, status, correlation_id)
      VALUES (${access.user.id}, ${access.workspace.id}, ${newsItemId}, ${result.text}, ${result.model}, ${result.inputTokens}, ${result.outputTokens}, ${result.estimatedCost}, 'drafted', ${correlationId})`;
    return NextResponse.json({ text: result.text, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedCost: result.estimatedCost, correlationId });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown error';
    console.error(JSON.stringify({ route: 'draft', correlationId, event: 'failed', newsItemId, model, error: message }));
    await sql`
      INSERT INTO drafts (user_id, workspace_id, news_item_id, text, model, input_tokens, output_tokens, estimated_cost, status, correlation_id, error_message)
      VALUES (${access.user.id}, ${access.workspace.id}, ${newsItemId}, '', ${model}, 0, 0, 0, 'failed', ${correlationId}, ${message})`;
    const rateLimited = message.includes('cap exceeded') || message.startsWith('OpenRouter 429');
    return NextResponse.json({ error: message, correlationId }, { status: rateLimited ? 429 : 502 });
  }
}
