import { sql } from './db';
import { DEFAULT_TEXT_MODEL, isTextModel } from './models';

const PER_DRAFT_CAP = Number(process.env.NIM_PER_DRAFT_TOKEN_CAP ?? 1500);
const DAILY_CAP = Number(process.env.NIM_DAILY_TOKEN_CAP ?? 20000);
const TIMEOUT_MS = 120_000;

export type DraftResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

export function defaultTextModel(): string {
  const env = process.env.NIM_MODEL?.trim();
  return env && isTextModel(env) ? env : DEFAULT_TEXT_MODEL;
}

export function resolveTextModel(workspaceModel?: string | null): string {
  const chosen = workspaceModel?.trim();
  return chosen && isTextModel(chosen) ? chosen : defaultTextModel();
}

export async function draftPost(
  prompt: string,
  model = defaultTextModel()
): Promise<DraftResult> {
  let res: Response;
  try {
    res = await fetch(`${process.env.NIM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NIM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: PER_DRAFT_CAP,
        // Reasoning models on NIM (Nemotron 3 Nano/Omni, Lightning, Super VL)
        // charge their hidden reasoning against max_tokens. With a post-sized
        // budget the reasoning can consume the whole allowance, so the request
        // succeeds with an empty `content` — the "empty draft" failure. A
        // short Facebook post does not need a reasoning trace, so ask the
        // endpoint to answer directly and keep the budget for the draft.
        reasoning_effort: 'none',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error('The AI model took too long to respond. Try a faster model.');
    }
    throw new Error('Could not reach the NVIDIA model endpoint.');
  }

  if (!res.ok) throw new Error(`NIM ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const choice = data.choices?.[0];
  const text: string = choice?.message?.content ?? '';
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const total = inputTokens + outputTokens;

  // Record the spend before validating the answer: NIM already billed these
  // tokens, including a draft that came back empty or over the per-draft cap.
  const today = new Date().toISOString().slice(0, 10);
  await sql`INSERT INTO usage_daily (day, total_tokens) VALUES (${today}, ${total})
            ON CONFLICT (day) DO UPDATE SET total_tokens = usage_daily.total_tokens + ${total}`;

  const row = await sql`SELECT total_tokens FROM usage_daily WHERE day = ${today}`;

  if (!text.trim()) {
    throw new Error(
      choice?.finish_reason === 'length'
        ? 'The AI ran out of tokens before writing the draft. Try again or pick a faster model.'
        : 'The model returned an empty draft. Try a different model.'
    );
  }

  if (total > PER_DRAFT_CAP) throw new Error('per-draft cap exceeded');

  if ((row[0]?.total_tokens ?? 0) > DAILY_CAP) {
    throw new Error('daily cap exceeded');
  }

  return { text, inputTokens, outputTokens, estimatedCost: total * 0.000001 };
}