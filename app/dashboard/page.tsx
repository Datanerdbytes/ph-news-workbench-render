"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  FileText,
  Images,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app-frame";
import { FacebookMark } from "@/components/facebook-mark";
import { PlatformMark } from "@/components/platform-mark";
import { StatusPill } from "@/components/status-pill";
import { Button, buttonVariants } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useFacebookConnection } from "@/components/facebook-connection";
import { TimeAgo } from "@/components/time-ago";
import { authClient } from "@/lib/auth-client";
import { cn } from "cn";
import { formatLongDate } from "@/lib/format";

type Draft = {
  id: number;
  status: string;
  news_title: string | null;
  created_at: string;
};

type Story = {
  id: number;
  title: string;
  status: string;
  created_at: string;
  draft_id: number | null;
};

type Activity = {
  id: string | number;
  type: "schedule" | "draft";
  event: string;
  source: string;
  displayTitle: string;
  displayTime: string;
  kind?: string | null;
  scheduleSource?: string | null;
  status?: string;
  facebookPostId?: string | null;
  errorMessage?: string | null;
  correlationId?: string;
  newsItemId?: number | null;
  scheduledPostId?: number | null;
  metadata?: Record<string, unknown> | null;
};

/** The platforms the Dashboard can report published counts for. */
type DashboardPlatform = "facebook" | "instagram" | "youtube" | "tiktok";

type PlatformStats = {
  published: {
    total: number;
    post: number;
    reel: number;
    live: number;
    story: number;
  };
  published30d: { total: number };
};

type PlatformStatsByName = Record<DashboardPlatform, PlatformStats>;

/** The part of the /api/analytics response the dashboard reads. */
type AnalyticsResponse = {
  platforms?: Array<{
    platform?: string;
    published?: PlatformStats["published"];
    published30d?: PlatformStats["published30d"];
  }>;
};

const PLATFORM_PILLS: Array<{ platform: DashboardPlatform; name: string }> = [
  { platform: "facebook", name: "Facebook" },
  { platform: "instagram", name: "Instagram" },
  { platform: "youtube", name: "YouTube" },
  { platform: "tiktok", name: "TikTok" },
];

function emptyPlatformStats(): PlatformStatsByName {
  const empty = (): PlatformStats => ({
    published: { total: 0, post: 0, reel: 0, live: 0, story: 0 },
    published30d: { total: 0 },
  });
  return {
    facebook: empty(),
    instagram: empty(),
    youtube: empty(),
    tiktok: empty(),
  };
}

/** Keeps only the platforms the Dashboard knows, so a stray row cannot leak in. */
function readPlatformStats(
  rows: AnalyticsResponse["platforms"]
): PlatformStatsByName {
  const stats = emptyPlatformStats();

  for (const row of rows ?? []) {
    const name = row?.platform;
    if (
      name !== "facebook" &&
      name !== "instagram" &&
      name !== "youtube" &&
      name !== "tiktok"
    ) {
      continue;
    }
    stats[name] = {
      published: {
        total: row.published?.total ?? 0,
        post: row.published?.post ?? 0,
        reel: row.published?.reel ?? 0,
        live: row.published?.live ?? 0,
        story: row.published?.story ?? 0,
      },
      published30d: { total: row.published30d?.total ?? 0 },
    };
  }

  return stats;
}

const PLANNED = [
  { platform: "instagram" as const, name: "Instagram", gate: "Meta App Review" },
  { platform: "youtube" as const, name: "YouTube", gate: "Google verification" },
  { platform: "tiktok" as const, name: "TikTok", gate: "Content Posting audit" },
  { platform: "linkedin" as const, name: "LinkedIn", gate: "Community API" },
];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function RetryButton({
  scheduledPostId,
  onSuccess,
}: {
  scheduledPostId: number;
  activityId: string | number;
  onSuccess: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function handleRetry() {
    setPending(true);
    try {
      const res = await fetch(`/api/schedule/${scheduledPostId}/retry`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Retry failed");
      toast.success("Post queued for retry", {
        description: "The scheduler will pick it up shortly.",
      });
      onSuccess();
    } catch (error) {
      toast.error("Could not queue retry", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleRetry}
      disabled={pending}
      aria-busy={pending}
      className="ml-2 h-8 rounded-[6px] px-2 text-[10.5px] border-muted-foreground/30 hover:bg-surface-2"
    >
      <RotateCcw className={`size-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden />
      <span className="ml-1">{pending ? "Retrying…" : "Retry"}</span>
    </Button>
  );
}

/**
 * The stat cards for the selected platform. Every platform leads with the
 * all-time total; the format cards follow the formats that platform's
 * pipeline actually tracks — no zero-cards for formats it never records.
 */
function platformStatCards(
  platform: DashboardPlatform,
  stats: PlatformStats,
  failed: boolean
): Array<{ label: string; value: number; hint: string; icon: typeof FileText }> {
  const total: {
    label: string;
    value: number;
    hint: string;
    icon: typeof FileText;
  } = {
    label: "Total published",
    value: stats.published.total,
    hint: failed
      ? "Publishing stats unavailable"
      : `${stats.published30d.total} in the last 30 days`,
    icon: Send,
  };

  if (platform === "instagram") {
    return [
      total,
      {
        label: "Post",
        value: stats.published.post,
        hint: "Feed posts",
        icon: FileText,
      },
    ];
  }

  if (platform === "youtube" || platform === "tiktok") {
    // These platforms only track one format, so their total IS the video
    // count — the card names the format instead of repeating the total.
    return [
      total,
      {
        label: "Videos",
        value: stats.published.total,
        hint: "Published videos",
        icon: Video,
      },
    ];
  }

  return [
    total,
    {
      label: "Post",
      value: stats.published.post,
      hint: "Feed posts",
      icon: FileText,
    },
    {
      label: "Reels",
      value: stats.published.reel,
      hint: "Short-form reels",
      icon: Play,
    },
    {
      label: "Live",
      value: stats.published.live,
      hint: "Live broadcasts",
      icon: Radio,
    },
    {
      label: "Stories",
      value: stats.published.story,
      hint: "Story posts",
      icon: Images,
    },
  ];
}

export default function DashboardPage() {
  const connection = useFacebookConnection();
  const { data: session } = authClient.useSession();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [platform, setPlatform] = useState<DashboardPlatform>("facebook");
  const [platformStats, setPlatformStats] =
    useState<PlatformStatsByName>(emptyPlatformStats);
  const [statsFailed, setStatsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const [draftsRes, itemsRes, activitiesRes, analyticsRes] =
        await Promise.all([
          fetch("/api/drafts", { cache: "no-store" }),
          fetch("/api/items", { cache: "no-store" }),
          fetch("/api/activity?mergeByStory=false&dedupe=false&limit=10", {
            cache: "no-store",
          }),
          // A rejected stats request must not reject the whole load — the
          // counters are their own failure.
          fetch("/api/analytics", { cache: "no-store" }).catch(() => null),
        ]);

      if (!draftsRes.ok || !itemsRes.ok || !activitiesRes.ok) {
        throw new Error("Could not load the workspace.");
      }

      const draftData = (await draftsRes.json()) as { drafts?: Draft[] };
      const storyData = (await itemsRes.json()) as
        | Story[]
        | { rows?: Story[] };
      const activityData = (await activitiesRes.json()) as
        | Activity[]
        | { rows?: Activity[]; nextCursor?: number | null; hasMore?: boolean };
      setDrafts(Array.isArray(draftData?.drafts) ? draftData.drafts : []);
      setStories(
        Array.isArray(storyData) ? storyData : (storyData.rows ?? [])
      );
      setActivities(
        Array.isArray(activityData) ? activityData : (activityData.rows ?? [])
      );

      // The publishing counters are their own failure: a hiccup there (a
      // network error, a 500, an unreadable body) must not take the
      // activity log down with it. The cards show a dash instead of a fake
      // zero.
      const analyticsData = analyticsRes?.ok
        ? ((await analyticsRes.json().catch(() => null)) as AnalyticsResponse | null)
        : null;
      const platforms = analyticsData?.platforms;

      if (Array.isArray(platforms)) {
        setPlatformStats(readPlatformStats(platforms));
        setStatsFailed(false);
      } else {
        setPlatformStats(emptyPlatformStats());
        setStatsFailed(true);
      }

      if (!Array.isArray(activityData)) {
        setNextCursor(
          typeof activityData.nextCursor === "number"
            ? activityData.nextCursor
            : null
        );
        setHasMore(Boolean(activityData.hasMore));
      } else {
        setNextCursor(null);
        setHasMore(false);
      }
      setLoadError(false);
    } catch (error) {
      setLoadError(true);
      toast.error("Could not load the dashboard", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/activity?mergeByStory=false&dedupe=false&limit=10&before=${nextCursor}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Could not load more activity");
      const data = (await res.json()) as {
        rows?: Activity[];
        nextCursor?: number | null;
        hasMore?: boolean;
      };
      const page = data.rows ?? [];
      setActivities((prev) => {
        const seen = new Set(prev.map((a) => `${a.type}-${a.id}`));
        return [
          ...prev,
          ...page.filter((a) => !seen.has(`${a.type}-${a.id}`)),
        ];
      });
      setNextCursor(typeof data.nextCursor === "number" ? data.nextCursor : null);
      setHasMore(Boolean(data.hasMore));
    } catch (error) {
      toast.error("Could not load more activity", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const ready = drafts.filter((draft) => draft.status === "drafted").length;
  const published = stories.filter(
    (story) => story.status === "published"
  ).length;
  const firstName = session?.user?.name?.split(/\s+/)[0];

  const stats = platformStats[platform];
  const statCards = platformStatCards(platform, stats, statsFailed);

  const steps = [
    {
      label: "Connect your Facebook Page",
      done: connection.connected,
      hint: connection.loading
        ? "Checking the Page connection."
        : connection.connected
          ? connection.page?.name ?? "Connected"
          : "Publishing needs a Page connection.",
    },
    {
      label: "Import stories from your feeds",
      done: stories.length > 0,
      hint:
        stories.length > 0
          ? `${stories.length} stories tracked`
          : "Open Sources and fetch your feeds.",
    },
    {
      label: "Generate your first draft",
      done: drafts.length > 0,
      hint:
        drafts.length > 0
          ? `${drafts.length} drafts created`
          : "Pick a story and draft a post.",
    },
    {
      label: "Review and publish a post",
      done: published > 0,
      hint:
        published > 0
          ? `${published} published`
          : ready > 0
            ? `${ready} draft${ready === 1 ? "" : "s"} waiting`
            : "Drafts will collect here for review.",
    },
  ];

  return (
    <AppFrame>
      <div className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:py-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[9.5px] font-bold uppercase tracking-[0.15em] text-brand">
              {formatLongDate()}
            </p>
            <h1 className="page-title mt-1.5">
              {greeting()}
              {firstName ? `, ${firstName}` : ""}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={refresh}
              disabled={refreshing}
              aria-busy={refreshing}
              className="h-9 rounded-[7px] border-line-strong bg-card px-3 text-[12px]"
            >
              <RefreshCw
                className={cn("size-3.5", refreshing && "animate-spin")}
                aria-hidden
              />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Link
              href="/sources"
              className={buttonVariants({
                variant: "brand",
                className: "h-9 rounded-[7px] px-3 text-[12px]",
              })}
            >
              Open sources
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </div>

        <div
          className="mt-5 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Publishing platform"
        >
          {PLATFORM_PILLS.map((pill) => {
            const active = platform === pill.platform;
            return (
              <button
                key={pill.platform}
                type="button"
                onClick={() => setPlatform(pill.platform)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
                  active
                    ? "border-transparent bg-ink text-paper"
                    : "border-border bg-card text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                )}
              >
                <PlatformMark
                  platform={pill.platform}
                  className="size-4 rounded-[5px]"
                />
                {pill.name}
              </button>
            );
          })}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5 xl:grid-cols-6">
          {statCards.map((card) => (
            <StatCard
              key={card.label}
              label={card.label}
              value={card.value}
              hint={card.hint}
              icon={card.icon}
              loading={loading || loadError || statsFailed}
            />
          ))}
          <article className="panel col-span-2 p-4 xl:col-span-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
                Publishing
              </span>
              <FacebookMark className="size-4" />
            </div>
            <p className="mt-3 truncate font-heading text-[24px] leading-none">
              {connection.loading
                ? "Checking…"
                : connection.connected
                  ? connection.page?.name ?? "Connected"
                  : "Not connected"}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  connection.loading
                    ? "animate-pulse bg-muted-foreground/50"
                    : connection.connected
                      ? "bg-success"
                      : connection.configured
                        ? "bg-warning"
                        : "bg-faint"
                )}
                aria-hidden
              />
              {connection.loading
                ? "Reading connection status"
                : connection.connected
                  ? "Facebook Page live"
                  : connection.configured
                    ? "Page available to connect"
                    : "Add Facebook app credentials"}
            </p>
          </article>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="text-[12.5px] font-semibold">Activity log</h2>
              <Link
                href="/status"
                className="text-[11px] font-semibold text-brand hover:text-brand-strong"
              >
                View all
              </Link>
            </div>

            {loading ? (
              <div className="divide-y divide-border">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="animate-pulse px-4 py-3.5">
                    <div className="h-2 w-20 rounded bg-muted" />
                    <div className="mt-2.5 h-3.5 w-2/3 rounded bg-muted" />
                    <div className="mt-2 h-2.5 w-1/3 rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : activities.length ? (
              <div className="divide-y divide-border">
                {activities.map((activity) => {
                  const isSchedule = activity.type === "schedule";
                  const isDraft = activity.type === "draft";
                  const kind = activity.kind ?? (isDraft ? "draft" : "post");
                  const scheduleSource = activity.scheduleSource ?? "local";
                  const status = activity.status ?? activity.event;

                  // Determine status variant for StatusPill
                  let pillStatus: string = status;
                  if (isDraft) {
                    pillStatus = status;
                  } else if (activity.event === "published") {
                    pillStatus = "published";
                  } else if (activity.event === "failed") {
                    pillStatus = "failed";
                  } else if (activity.event === "canceled") {
                    pillStatus = "canceled";
                  } else if (activity.event === "scheduled") {
                    pillStatus = "scheduled";
                  }

                  return (
                    <div key={`${activity.type}-${activity.id}`}>
                      <Link
                        href={isSchedule
                          ? `/calendar?post=${activity.scheduledPostId}`
                          : `/drafts/${activity.id}`}
                        className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill status={pillStatus} />
                            <TimeAgo
                              date={activity.displayTime}
                              className="text-[10.5px] tabular-nums text-muted-foreground"
                            />
                            {kind && (
                              <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 rounded bg-surface-2">
                                {kind.toUpperCase()}
                              </span>
                            )}
                            {isSchedule && scheduleSource === "facebook" && (
                              <span className="text-[9px] font-medium text-brand px-1.5 py-0.5 rounded bg-brand-soft">
                                FB
                              </span>
                            )}
                          </div>
                          <p className="mt-1.5 line-clamp-2 font-heading text-[15.5px] leading-snug">
                            {activity.displayTitle}
                          </p>
                          {(activity.errorMessage || (isDraft && activity.status === "failed")) && (
                            <p className="mt-1.5 line-clamp-2 text-xs text-destructive">
                              {activity.errorMessage ?? "Failed to publish"}
                            </p>
                          )}
                        </div>
                        <ArrowUpRight
                          className="mt-1 size-3.5 shrink-0 text-faint transition-colors group-hover:text-foreground"
                          aria-hidden
                        />
                      </Link>
                      {isSchedule &&
                        activity.event === "failed" &&
                        activity.scheduledPostId && (
                        <RetryButton
                          scheduledPostId={activity.scheduledPostId}
                          activityId={activity.id}
                          onSuccess={() => load()}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : loadError ? (
              <ErrorState
                compact
                className="m-4"
                title="Couldn't load recent activity"
                onRetry={load}
              />
            ) : (
              <div className="px-4 py-12 text-center">
                <Clock className="mx-auto size-5 text-faint" aria-hidden />
                <p className="mt-2 text-[12.5px] font-semibold">No activity yet</p>
                <p className="mx-auto mt-1 max-w-[260px] text-[11px] leading-relaxed text-muted-foreground">
                  Scheduled posts, published content, and drafts will appear here.
                </p>
                <Link
                  href="/sources"
                  className={buttonVariants({
                    variant: "brand",
                    size: "sm",
                    className: "mt-4 h-8 rounded-[7px] px-3 text-[11.5px]",
                  })}
                >
                  Open sources
                </Link>
              </div>
            )}

            {!loading && activities.length > 0 && (
              <footer className="border-t border-border bg-card/60 px-3 py-2.5">
                {hasMore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    aria-busy={loadingMore}
                    className="w-full"
                  >
                    {loadingMore ? (
                      <RefreshCw
                        className="size-3.5 animate-spin"
                        aria-hidden
                      />
                    ) : (
                      <ChevronDown className="size-3.5" aria-hidden />
                    )}
                    {loadingMore ? "Loading…" : "Load more activity"}
                  </Button>
                ) : (
                  <p className="py-1 text-center text-[10.5px] text-muted-foreground">
                    All activity loaded
                  </p>
                )}
              </footer>
            )}
          </section>

          <div className="flex flex-col gap-4">
            <section className="panel p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[12.5px] font-semibold">Channels</h2>
                <Link
                  href="/accounts"
                  className="text-[11px] font-semibold text-brand hover:text-brand-strong"
                >
                  Manage
                </Link>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                  <PlatformMark platform="facebook" className="size-7 rounded-md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-semibold">
                      Facebook
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {connection.loading
                        ? "Checking…"
                        : connection.connected
                          ? connection.page?.name
                          : "Ready to connect"}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider",
                      connection.loading
                        ? "bg-surface-3 text-muted-foreground"
                        : connection.connected
                          ? "bg-success-soft text-success"
                          : "bg-warning-soft text-warning"
                    )}
                  >
                    {connection.loading
                      ? "Checking"
                      : connection.connected
                        ? "Live"
                        : "Pending"}
                  </span>
                </div>

                {PLANNED.map((channel) => (
                  <div
                    key={channel.platform}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5"
                  >
                    <PlatformMark
                      platform={channel.platform}
                      className="size-7 rounded-md opacity-45"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] font-medium text-muted-foreground">
                        {channel.name}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {channel.gate}
                      </p>
                    </div>
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
                      Designed
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel p-4">
              <h2 className="text-[12.5px] font-semibold">Next steps</h2>
              <ul className="mt-3 flex flex-col gap-2.5">
                {steps.map((step) => (
                  <li key={step.label} className="flex items-start gap-2">
                    {step.done ? (
                      <CheckCircle2
                        className="mt-0.5 size-3.5 shrink-0 text-success"
                        aria-hidden
                      />
                    ) : (
                      <Circle
                        className="mt-0.5 size-3.5 shrink-0 text-faint"
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "text-[11.5px] font-medium leading-tight",
                          step.done && "text-muted-foreground"
                        )}
                      >
                        {step.label}
                      </p>
                      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                        {step.hint}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  icon: typeof FileText;
  loading: boolean;
  tone?: string;
}) {
  return (
    <article className="panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
          {label}
        </span>
        <Icon className={cn("size-4 text-muted-foreground", tone)} aria-hidden />
      </div>
      <p className="mt-3 font-heading text-[30px] leading-none tabular-nums">
        {loading ? "—" : value}
      </p>
      <p className="mt-2 text-[11px] text-muted-foreground">{hint}</p>
    </article>
  );
}
