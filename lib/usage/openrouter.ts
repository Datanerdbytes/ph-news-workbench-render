import {
  MalformedUsageResponseError,
  parseNumber,
  parseOptionalNumber,
  parseOptionalRecord,
  parseRecord,
  readJson,
  unavailable,
  unavailableForError,
  unavailableForStatus,
} from "./shared";
import type { OpenRouterUsage, UsageResult } from "./types";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const TIMEOUT_MS = 10_000;

/**
 * Server-only OpenRouter adapter. It returns a sanitized account-usage
 * snapshot; credentials and upstream response bodies never leave this module.
 */
export async function getOpenRouterUsage(): Promise<
  UsageResult<OpenRouterUsage>
> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return unavailable("openrouter", "not_configured");

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      cache: "no-store",
      signal,
    });

    if (!response.ok) return unavailableForStatus("openrouter", response.status);

    const root = parseRecord(await readJson(response, signal));
    const data = parseRecord(root.data);
    const daily = parseOptionalRecord(data.free_model_daily_requests);

    return {
      status: "available",
      data: {
        creditsUsedUsd: parseNumber(data.usage),
        keyLimitUsd: parseOptionalNumber(data.limit),
        keyRemainingUsd: parseOptionalNumber(data.limit_remaining),
        dailyFreeRequests: daily
          ? {
              used: parseOptionalNumber(daily.used),
              limit: parseOptionalNumber(daily.limit),
              remaining: parseOptionalNumber(daily.remaining),
            }
          : null,
      },
    };
  } catch (error) {
    if (error instanceof MalformedUsageResponseError) {
      return unavailable("openrouter", "malformed_response");
    }
    return unavailableForError("openrouter", error, signal);
  }
}
