import {
  MalformedUsageResponseError,
  parseMoney,
  parseOptionalBoolean,
  parseOptionalDate,
  parseOptionalString,
  parseRecord,
  readJson,
  unavailable,
  unavailableForError,
  unavailableForStatus,
} from "./shared";
import type { AzureCreditLot, AzureUsage, UsageResult } from "./types";

const API_VERSION = "2026-06-01";
const TIMEOUT_MS = 10_000;

const AZURE_ENV_KEYS = [
  "AZURE_BILLING_TENANT_ID",
  "AZURE_BILLING_CLIENT_ID",
  "AZURE_BILLING_CLIENT_SECRET",
  "AZURE_BILLING_ACCOUNT_ID",
  "AZURE_BILLING_PROFILE_ID",
] as const;

type AzureEnvKey = (typeof AZURE_ENV_KEYS)[number];

type AzureBillingConfig = Record<AzureEnvKey, string>;

function readConfig(): AzureBillingConfig | null {
  const values = Object.fromEntries(
    AZURE_ENV_KEYS.map((key) => [key, process.env[key]?.trim() ?? ""])
  ) as Record<AzureEnvKey, string>;

  if (Object.values(values).some((value) => !value)) return null;
  return values as AzureBillingConfig;
}

async function requestAccessToken(
  config: AzureBillingConfig,
  signal: AbortSignal
): Promise<UsageResult<string>> {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
    config.AZURE_BILLING_TENANT_ID
  )}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.AZURE_BILLING_CLIENT_ID,
    client_secret: config.AZURE_BILLING_CLIENT_SECRET,
    scope: "https://management.azure.com/.default",
  });

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      // Microsoft returns 400 for invalid client credentials as well as for
      // malformed token requests. Either way the browser gets a safe auth state.
      if (response.status === 400) return unavailable("azure", "unauthorized");
      return unavailableForStatus("azure", response.status);
    }

    const root = parseRecord(await readJson(response, signal));
    const accessToken = parseOptionalString(root.access_token);
    if (!accessToken?.trim()) throw new MalformedUsageResponseError();
    return { status: "available", data: accessToken };
  } catch (error) {
    if (error instanceof MalformedUsageResponseError) {
      return unavailable("azure", "malformed_response");
    }
    return unavailableForError("azure", error, signal);
  }
}

async function requestAzureJson(
  url: string,
  accessToken: string,
  signal: AbortSignal
): Promise<UsageResult<unknown>> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      signal,
    });

    if (!response.ok) return unavailableForStatus("azure", response.status);
    return { status: "available", data: await readJson(response, signal) };
  } catch (error) {
    if (error instanceof MalformedUsageResponseError) {
      return unavailable("azure", "malformed_response");
    }
    return unavailableForError("azure", error, signal);
  }
}

function parseLot(value: unknown): AzureCreditLot {
  const item = parseRecord(value);
  const properties = parseRecord(item.properties);
  return {
    source: parseOptionalString(properties.source),
    startDate: parseOptionalDate(properties.startDate),
    expirationDate: parseOptionalDate(properties.expirationDate),
    status: parseOptionalString(properties.status),
    originalAmount: parseMoney(properties.originalAmount),
    closedBalance: parseMoney(properties.closedBalance),
    isEstimatedBalance: parseOptionalBoolean(properties.isEstimatedBalance),
  };
}

/**
 * Server-only MCA Consumption adapter. Balances come only from Azure's
 * balanceSummary; no remaining-credit amount is inferred from a starting grant.
 */
export async function getAzureUsage(): Promise<UsageResult<AzureUsage>> {
  const config = readConfig();
  if (!config) return unavailable("azure", "not_configured");

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const token = await requestAccessToken(config, signal);
  if (token.status === "unavailable") return token;

  const consumptionBase = `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(
    config.AZURE_BILLING_ACCOUNT_ID
  )}/billingProfiles/${encodeURIComponent(
    config.AZURE_BILLING_PROFILE_ID
  )}/providers/Microsoft.Consumption`;
  const balanceUrl = `${consumptionBase}/credits/balanceSummary?api-version=${API_VERSION}`;
  const lotsUrl = `${consumptionBase}/lots?api-version=${API_VERSION}`;

  const balanceResult = await requestAzureJson(balanceUrl, token.data, signal);
  if (balanceResult.status === "unavailable") return balanceResult;

  try {
  // Accumulate all credit-lot pages.
  const allLots: unknown[] = [];
  let nextUrl: string | null = lotsUrl;
  while (nextUrl) {
    const pageResult = await requestAzureJson(nextUrl, token.data, signal);
    if (pageResult.status === "unavailable") return pageResult;
    const pageRoot = parseRecord(pageResult.data);
    if (!Array.isArray(pageRoot.value)) throw new MalformedUsageResponseError();
    allLots.push(...pageRoot.value);
    const nextLink = pageRoot.nextLink;
    nextUrl =
      typeof nextLink === "string" &&
      nextLink.startsWith("https://") &&
      new URL(nextLink).origin === "https://management.azure.com"
        ? nextLink
        : null;
  }

    const balanceRoot = parseRecord(balanceResult.data);
    const properties = parseRecord(balanceRoot.properties);
    const balanceSummary = parseRecord(properties.balanceSummary);

    return {
      status: "available",
      data: {
        currentBalance: parseMoney(balanceSummary.currentBalance),
        estimatedBalance: parseMoney(balanceSummary.estimatedBalance),
        billingCurrency: parseOptionalString(properties.billingCurrency),
        creditCurrency: parseOptionalString(properties.creditCurrency),
        expiredCredit: parseMoney(properties.expiredCredit),
        pendingCreditAdjustments: parseMoney(
          properties.pendingCreditAdjustments
        ),
        pendingEligibleCharges: parseMoney(properties.pendingEligibleCharges),
        isEstimatedBalance: parseOptionalBoolean(properties.isEstimatedBalance),
        lots: allLots.map(parseLot),
      },
    };
  } catch (error) {
    if (error instanceof MalformedUsageResponseError) {
      return unavailable("azure", "malformed_response");
    }
    return unavailableForError("azure", error, signal);
  }
}
