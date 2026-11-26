import { sql } from './db';
import { DEFAULT_TEXT_MODEL, isTextModel, TEXT_MODELS } from './models';

// The per-draft cap covers input AND output: drafts now carry article text
// (~1k tokens of context), so the NIM-era 1,500 budget would trip itself.
const PER_DRAFT_CAP = Number(process.env.OPENROUTER_PER_DRAFT_TOKEN_CAP ?? 4000);
const DAILY_CAP = Number(process.env.OPENROUTER_DAILY_TOKEN_CAP ?? 60000);
// Output only. A post needs a few hundred tokens; a runaway reply — or hidden
// reasoning a model will not switch off — is cut off here, which reads as a
// truncated reply the fallback chain retries on another model instead of a
// draft that eats the whole per-draft budget.
const OUTPUT_CAP = Number(process.env.OPENROUTER_OUTPUT_TOKEN_CAP ?? 1000);
const TIMEOUT_MS = 120_000;

export type DraftResult = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

export function defaultTextModel(): string {
  const env = process.env.OPENROUTER_MODEL?.trim();
  return env && isTextModel(env) ? env : DEFAULT_TEXT_MODEL;
}

export function resolveTextModel(workspaceModel?: string | null): string {
  const chosen = workspaceModel?.trim();
  return chosen && isTextModel(chosen) ? chosen : defaultTextModel();
}

/**
 * Free catalog ids rotate — OpenRouter retires them without warning — and the
 * free tier rides shared upstream capacity that throttles under load. A
 * retired model, an empty or truncated reply, and an upstream throttle are
 * all worth retrying on another catalog model rather than surfacing. The
 * account's own free-tier limits (429 "free-models-per-day") must stop
 * immediately: every free model shares that quota, so a retry would burn
 * requests for nothing — and our own caps are spend guards, not model health.
 */
class ModelUnavailableError extends Error {}

function isModelMissing(status: number, body: string): boolean {
  return (
    status === 404 || /no endpoints found|not a valid model|no model found/i.test(body)
  );
}

/** Shared upstream capacity throttling under load — another provider may serve. */
function isUpstreamThrottle(status: number, body: string): boolean {
  return status === 429 && /temporarily rate-limited upstream/i.test(body);
}

async function draftWithModel(
  prompt: string,
  model: string,
  baseUrl: string
): Promise<DraftResult> {
  // Some free endpoints force reasoning on and reject any attempt to disable
  // it with a 400 — for those, send no reasoning param at all and give the
  // hidden reasoning room inside the output budget. The per-draft cap still
  // bounds the combined spend.
  const reasoningMandatory =
    TEXT_MODELS.find((entry) => entry.id === model)?.reasoning === 'mandatory';
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: reasoningMandatory ? OUTPUT_CAP * 2 : OUTPUT_CAP,
  };
  if (!reasoningMandatory) {
    // Reasoning models charge their hidden reasoning against max_tokens. With
    // a post-sized budget the reasoning can consume the whole allowance, so
    // the request succeeds with an empty `content` — the "empty draft"
    // failure. A short Facebook post does not need a reasoning trace, so ask
    // for a direct answer.
    body.reasoning = { enabled: false };
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // Optional attribution headers; they only affect app rankings on
        // OpenRouter's leaderboards but cost nothing to send.
        'HTTP-Referer': process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
        'X-Title': 'PH News Workbench',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error('The AI model took too long to respond. Try a faster model.');
    }
    throw new Error('Could not reach the OpenRouter endpoint.');
  }

  if (!res.ok) {
    const body = await res.text();
    if (isModelMissing(res.status, body) || isUpstreamThrottle(res.status, body)) {
      throw new ModelUnavailableError(`OpenRouter ${res.status}: ${body}`);
    }
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const text: string = choice?.message?.content ?? '';
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const total = inputTokens + outputTokens;

  // Record the spend before validating the answer: the tokens are spent even
  // on a draft that came back empty or over the per-draft cap.
  const today = new Date().toISOString().slice(0, 10);
  await sql`INSERT INTO usage_daily (day, total_tokens) VALUES (${today}, ${total})
            ON CONFLICT (day) DO UPDATE SET total_tokens = usage_daily.total_tokens + ${total}`;

  const row = await sql`SELECT total_tokens FROM usage_daily WHERE day = ${today}`;

  if (!text.trim()) {
    // Truncation and empty replies are model-specific — a different catalog
    // model may answer within the same budget.
    throw new ModelUnavailableError(
      choice?.finish_reason === 'length'
        ? 'The AI ran out of tokens before writing the draft.'
        : 'The model returned an empty draft.'
    );
  }

  if (total > PER_DRAFT_CAP) throw new Error('per-draft cap exceeded');

  if ((row[0]?.total_tokens ?? 0) > DAILY_CAP) {
    throw new Error('daily cap exceeded');
  }

  // Every catalog model is an OpenRouter ":free" entry, so the spend is $0;
  // the token counts still feed the per-draft and daily caps.
  return { text, model, inputTokens, outputTokens, estimatedCost: 0 };
}

export async function draftPost(
  prompt: string,
  model = defaultTextModel()
): Promise<DraftResult> {
  // Overridable so tests can point at a stub server.
  const baseUrl =
    process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';

  // The requested model answers first; the rest of the catalog follows in
  // order so a retired id degrades to another summarization-capable model.
  const candidates = [
    model,
    ...TEXT_MODELS.map((entry) => entry.id).filter((id) => id !== model),
  ];

  for (const candidate of candidates) {
    try {
      return await draftWithModel(prompt, candidate, baseUrl);
    } catch (e) {
      if (e instanceof ModelUnavailableError) {
        // Visible in server logs: a catalog id has gone stale and the chain
        // moved on — the signal to update lib/models.ts.
        console.warn(
          JSON.stringify({ route: 'ai', event: 'model_fallback', failed: candidate, error: e.message })
        );
        continue;
      }
      throw e;
    }
  }

  throw new Error(
    'The AI could not write the draft with any available model. Try again shortly.'
  );
}
