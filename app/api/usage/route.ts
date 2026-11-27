import { NextResponse } from "next/server";
import { getAzureUsage } from "@/lib/usage/azure";
import { getOpenRouterUsage } from "@/lib/usage/openrouter";
import { unavailable } from "@/lib/usage/shared";
import { requireWorkspace, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  // Provider adapters return honest unavailable states. allSettled also keeps
  // an unexpected adapter rejection from hiding the other provider's snapshot.
  const [openrouter, azure] = await Promise.allSettled([
    getOpenRouterUsage(),
    getAzureUsage(),
  ]);

  return NextResponse.json(
    {
      openrouter:
        openrouter.status === "fulfilled"
          ? openrouter.value
          : unavailable("openrouter", "upstream_unavailable"),
      azure:
        azure.status === "fulfilled"
          ? azure.value
          : unavailable("azure", "upstream_unavailable"),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
