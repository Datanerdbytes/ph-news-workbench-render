export type Money = {
  currency: string | null;
  value: number;
};

export type OpenRouterUsage = {
  creditsUsedUsd: number;
  keyLimitUsd: number | null;
  keyRemainingUsd: number | null;
  dailyFreeRequests: {
    used: number | null;
    limit: number | null;
    remaining: number | null;
  } | null;
};

/** The free credit left on an Azure subscription, derived from its usage. */
export type AzureUsage = {
  /** The grant total this card is measured against. */
  granted: Money;
  /** The grant minus every credit-eligible charge Azure has posted; never below zero. */
  remaining: Money;
  /** Credit-eligible charges posted so far. */
  consumed: Money;
  /** Latest usage day Azure has posted. Usage lands up to a day late. */
  reportedThrough: string | null;
  /** When the grant lapses; null when it is not configured. */
  expiresAt: string | null;
};

export type UsageUnavailableCode =
  | "not_configured"
  | "unauthorized"
  | "forbidden"
  | "unsupported"
  | "timeout"
  | "malformed_response"
  | "upstream_unavailable";

export type UsageResult<T> =
  | { status: "available"; data: T }
  | {
      status: "unavailable";
      code: UsageUnavailableCode;
      message: string;
    };

export type UsageResponse = {
  openrouter: UsageResult<OpenRouterUsage>;
  azure: UsageResult<AzureUsage>;
};
