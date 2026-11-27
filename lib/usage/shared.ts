import type {
  Money,
  UsageResult,
  UsageUnavailableCode,
} from "./types";

export type UsageProvider = "openrouter" | "azure";

export class MalformedUsageResponseError extends Error {
  constructor() {
    super("Malformed provider usage response");
    this.name = "MalformedUsageResponseError";
  }
}

const UNAVAILABLE_MESSAGES: Record<
  UsageProvider,
  Record<UsageUnavailableCode, string>
> = {
  openrouter: {
    not_configured:
      "OpenRouter usage is not configured. Set OPENROUTER_API_KEY on the server.",
    unauthorized:
      "OpenRouter rejected the server credentials. Check OPENROUTER_API_KEY.",
    forbidden:
      "OpenRouter denied access to key usage. Check the key permissions.",
    unsupported: "OpenRouter key usage is not supported for this key.",
    timeout: "OpenRouter took too long to respond. Try refreshing shortly.",
    malformed_response:
      "OpenRouter returned an unreadable usage response. Try refreshing shortly.",
    upstream_unavailable:
      "OpenRouter usage is temporarily unavailable. Try refreshing shortly.",
  },
  azure: {
    not_configured:
      "Azure billing is not configured. Add the AZURE_BILLING_* server environment variables.",
    unauthorized:
      "Azure rejected the billing credentials. Check the server-side Azure billing configuration.",
    forbidden:
      "Azure denied access to billing usage. Check the service principal permissions.",
    unsupported:
      "Azure credit usage is not available for this billing agreement or billing profile.",
    timeout: "Azure billing took too long to respond. Try refreshing shortly.",
    malformed_response:
      "Azure returned an unreadable usage response. Try refreshing shortly.",
    upstream_unavailable:
      "Azure billing usage is temporarily unavailable. Try refreshing shortly.",
  },
};

export function unavailable(
  provider: UsageProvider,
  code: UsageUnavailableCode
): UsageResult<never> {
  return {
    status: "unavailable",
    code,
    message: UNAVAILABLE_MESSAGES[provider][code],
  };
}

export function unavailableForStatus(
  provider: UsageProvider,
  status: number
): UsageResult<never> {
  if (status === 401) return unavailable(provider, "unauthorized");
  if (status === 403) return unavailable(provider, "forbidden");
  if (status === 404 && provider === "azure") {
    return unavailable(provider, "unsupported");
  }
  return unavailable(provider, "upstream_unavailable");
}

export function unavailableForError(
  provider: UsageProvider,
  error: unknown,
  signal: AbortSignal
): UsageResult<never> {
  if (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  ) {
    return unavailable(provider, "timeout");
  }
  return unavailable(provider, "upstream_unavailable");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new MalformedUsageResponseError();
  return value;
}

export function parseOptionalRecord(
  value: unknown
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return parseRecord(value);
}

export function parseNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MalformedUsageResponseError();
  }
  return value;
}

export function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return parseNumber(value);
}

export function parseOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MalformedUsageResponseError();
  return value;
}

export function parseOptionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new MalformedUsageResponseError();
  return value;
}

export function parseOptionalDate(value: unknown): string | null {
  const date = parseOptionalString(value);
  if (date !== null && !Number.isFinite(Date.parse(date))) {
    throw new MalformedUsageResponseError();
  }
  return date;
}

export function parseMoney(value: unknown): Money | null {
  const amount = parseOptionalRecord(value);
  if (!amount) return null;
  return {
    currency: parseOptionalString(amount.currency),
    value: parseNumber(amount.value),
  };
}

export async function readJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      throw error;
    }
    throw new MalformedUsageResponseError();
  }
}
