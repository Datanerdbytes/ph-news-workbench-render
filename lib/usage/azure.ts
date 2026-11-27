import {
  MalformedUsageResponseError,
  parseNumber,
  parseOptionalBoolean,
  parseOptionalDate,
  parseOptionalString,
  parseRecord,
  readJson,
  unavailable,
  unavailableForError,
  unavailableForStatus,
} from "./shared";
import type { AzureUsage, Money, UsageResult } from "./types";

const API_VERSION = "2023-05-01";
// Per-request budget: each token and usage page gets its own, so a long
// pagination run cannot exhaust one shared clock.
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 1000;
const AZURE_MANAGEMENT_ORIGIN = "https://management.azure.com";

const AZURE_ENV_KEYS = [
  "AZURE_BILLING_TENANT_ID",
  "AZURE_BILLING_CLIENT_ID",
  "AZURE_BILLING_CLIENT_SECRET",
  "AZURE_BILLING_SUBSCRIPTION_ID",
  "AZURE_BILLING_CREDIT_TOTAL",
] as const;

type AzureEnvKey = (typeof AZURE_ENV_KEYS)[number];

type AzureBillingConfig = Record<AzureEnvKey, string> & {
  creditTotal: number;
  // The grant's first day: usage before it never touched this credit.
  creditStart: string | null;
  creditExpiresAt: string | null;
};

/** A trimmed env date: null when unset, undefined when it cannot be parsed. */
function envDate(name: string): string | null | undefined {
  const value = process.env[name]?.trim();
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function readConfig(): AzureBillingConfig | null {
  const values = Object.fromEntries(
    AZURE_ENV_KEYS.map((key) => [key, process.env[key]?.trim() ?? ""])
  ) as Record<AzureEnvKey, string>;

  if (Object.values(values).some((value) => !value)) return null;

  const creditTotal = Number(values.AZURE_BILLING_CREDIT_TOTAL);
  const creditStart = envDate("AZURE_BILLING_CREDIT_START");
  const creditExpiresAt = envDate("AZURE_BILLING_CREDIT_EXPIRES");
  if (
    !Number.isFinite(creditTotal) ||
    creditTotal < 0 ||
    creditStart === undefined ||
    creditExpiresAt === undefined
  ) {
    return null;
  }
  return { ...values, creditTotal, creditStart, creditExpiresAt };
}

async function requestAccessToken(
  config: AzureBillingConfig
): Promise<UsageResult<string>> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
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
  accessToken: string
): Promise<UsageResult<unknown>> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
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

/** The next page link, when it stays on Azure's management endpoint. */
function nextPageLink(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  try {
    return new URL(value).origin === AZURE_MANAGEMENT_ORIGIN ? value : null;
  } catch {
    return null;
  }
}

type UsageTotals = {
  consumed: number;
  currency: string | null;
  reportedThrough: string | null;
};

function addUsage(totals: UsageTotals, item: unknown, since: number | null) {
  const properties = parseRecord(parseRecord(item).properties);
  const date = parseOptionalDate(properties.date);
  if (date === null) throw new MalformedUsageResponseError();
  // Azure ignores date filters on this endpoint, so the window lives here.
  if (since !== null && Date.parse(date) < since) return;

  const cost = parseNumber(properties.costInBillingCurrency);
  const currency = parseOptionalString(properties.billingCurrencyCode);
  // One subscription is billed in one currency; a second one makes the sum
  // meaningless.
  if (currency && totals.currency && currency !== totals.currency) {
    throw new MalformedUsageResponseError();
  }
  totals.currency ??= currency;
  // Charges Azure marks as credit-ineligible never draw the grant down.
  if (parseOptionalBoolean(properties.isAzureCreditEligible) !== false) {
    totals.consumed += cost;
  }
  if (
    totals.reportedThrough === null ||
    Date.parse(date) > Date.parse(totals.reportedThrough)
  ) {
    totals.reportedThrough = date;
  }
}

/**
 * Server-only adapter for the free credit left on an Azure subscription.
 * Billing's own balance API needs a billing role a personal MCA account
 * cannot grant through ARM, so the remainder is derived instead: the grant
 * minus every credit-eligible charge in the subscription's usage.
 */
export async function getAzureUsage(): Promise<UsageResult<AzureUsage>> {
  const config = readConfig();
  if (!config) return unavailable("azure", "not_configured");

  const token = await requestAccessToken(config);
  if (token.status === "unavailable") return token;

  const usageUrl = `${AZURE_MANAGEMENT_ORIGIN}/subscriptions/${encodeURIComponent(
    config.AZURE_BILLING_SUBSCRIPTION_ID
  )}/providers/Microsoft.Consumption/usageDetails?api-version=${API_VERSION}&$top=${PAGE_SIZE}`;
  const since =
    config.creditStart === null ? null : Date.parse(config.creditStart);

  try {
    const totals: UsageTotals = {
      consumed: 0,
      currency: null,
      reportedThrough: null,
    };
    let nextUrl: string | null = usageUrl;
    while (nextUrl) {
      const page = await requestAzureJson(nextUrl, token.data);
      if (page.status === "unavailable") return page;
      const root = parseRecord(page.data);
      if (!Array.isArray(root.value)) throw new MalformedUsageResponseError();
      for (const item of root.value) addUsage(totals, item, since);
      nextUrl = nextPageLink(root.nextLink);
    }

    const money = (value: number): Money => ({
      currency: totals.currency,
      value,
    });
    return {
      status: "available",
      data: {
        granted: money(config.creditTotal),
        remaining: money(Math.max(0, config.creditTotal - totals.consumed)),
        consumed: money(totals.consumed),
        reportedThrough: totals.reportedThrough,
        expiresAt: config.creditExpiresAt,
      },
    };
  } catch (error) {
    if (error instanceof MalformedUsageResponseError) {
      return unavailable("azure", "malformed_response");
    }
    // Request-level errors (timeout, auth, HTTP) are already converted to
    // unavailable results inside requestAccessToken/requestAzureJson.
    return unavailable("azure", "upstream_unavailable");
  }
}
