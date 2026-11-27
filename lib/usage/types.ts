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

export type AzureCreditLot = {
  source: string | null;
  startDate: string | null;
  expirationDate: string | null;
  status: string | null;
  originalAmount: Money | null;
  closedBalance: Money | null;
  isEstimatedBalance: boolean | null;
};

export type AzureUsage = {
  currentBalance: Money | null;
  estimatedBalance: Money | null;
  billingCurrency: string | null;
  creditCurrency: string | null;
  expiredCredit: Money | null;
  pendingCreditAdjustments: Money | null;
  pendingEligibleCharges: Money | null;
  isEstimatedBalance: boolean | null;
  lots: AzureCreditLot[];
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
