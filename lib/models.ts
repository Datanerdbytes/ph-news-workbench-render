export type TextModel = {
  id: string;
  label: string;
  detail: string;
  /**
   * Some free endpoints force reasoning on and reject any attempt to disable
   * it ("Reasoning is mandatory for this endpoint"). Such models get no
   * reasoning param and a doubled output budget, since hidden reasoning
   * tokens are billed against max_tokens.
   */
  reasoning?: "mandatory";
};

// OpenRouter free tier, kept to models suited to summarizing news into short
// Facebook posts. The free list rotates often — if an id starts returning
// 404/429-only errors, swap it for another ":free" entry from
// openrouter.ai/models (input+output price 0).
export const TEXT_MODELS: TextModel[] = [
  {
    id: "google/gemma-4-26b-a4b-it:free",
    label: "Gemma 4 26B Flash",
    detail: "Light — MoE with 3.8B active parameters; quick replies",
  },
  {
    id: "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B",
    detail: "Dense 31B model; a solid all-round default",
  },
  {
    id: "inclusionai/ling-3.2-flash:free",
    label: "Ling 3.2 Flash",
    detail: "Hybrid reasoning model with a 1M-token context window",
  },
  {
    id: "baidu/ernie-5.5-flash-preview:free",
    label: "ERNIE 5.5 Flash",
    detail: "280B MoE in preview; 1M-token context window",
    reasoning: "mandatory",
  },
];

export const DEFAULT_TEXT_MODEL = "google/gemma-4-31b-it:free";

export function isTextModel(value: string): boolean {
  return TEXT_MODELS.some((model) => model.id === value);
}

export function textModelLabel(value: string): string {
  return TEXT_MODELS.find((model) => model.id === value)?.label ?? value;
}
