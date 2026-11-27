"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Cloud,
  Eye,
  FileText,
  Heart,
  KeyRound,
  MessageCircle,
  Newspaper,
  RefreshCw,
  Share2,
  Sparkles,
} from "lucide-react";
import { AppFrame } from "@/components/app-frame";
import { useFacebookConnection } from "@/components/facebook-connection";
import { PlatformMark } from "@/components/platform-mark";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import {
  ANALYTICS_RANGES,
  DEFAULT_ANALYTICS_RANGE,
  lastNDays,
  type AnalyticsRange,
} from "@/lib/analytics/days";
import type {
  AzureCreditLot,
  AzureUsage,
  Money,
  OpenRouterUsage,
  UsageResponse,
  UsageResult,
} from "@/lib/usage/types";
import { cn } from "cn";

type TopPost = {
  id: string;
  message: string | null;
  permalinkUrl: string | null;
  createdAt: string;
  shares: number | null;
  reactions: number | null;
  comments: number | null;
};

type InstagramPost = {
  id: string;
  caption: string | null;
  permalink: string | null;
  timestamp: string;
  mediaType: string | null;
  likes: number | null;
  comments: number | null;
};

type InstagramOverview = {
  username: string | null;
  followers: number | null;
  mediaCount: number | null;
  recent: InstagramPost[];
};

type YouTubeVideo = {
  id: string;
  title: string;
  publishedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  url: string;
};

type YouTubeChannelStats = {
  id: string;
  title: string;
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
};

type YouTubeInsights = {
  connected?: boolean;
  configured?: boolean;
  channel?: YouTubeChannelStats | null;
  recent?: YouTubeVideo[];
  reason?: string | null;
};

type Totals = {
  drafts: number;
  published: number;
  scheduled: number;
  failed: number;
  tokens: number;
  cost: number;
};

type Day = {
  day: string;
  drafts: number;
  published: number;
  scheduled: number;
  failed: number;
};

type PageInsights = {
  connected: boolean;
  available?: boolean;
  pageName?: string;
  fans?: number | null;
  followers?: number | null;
  engagements7d?: number | null;
  mediaViews7d?: number | null;
  topPosts?: TopPost[] | null;
  topPostsError?: string | null;
  instagram?: InstagramOverview | null;
  instagramError?: string | null;
  reason?: string;
};

function clientUsageUnavailable(): UsageResult<never> {
  return {
    status: "unavailable",
    code: "upstream_unavailable",
    message: "Provider usage is temporarily unavailable. Try refreshing shortly.",
  };
}

function shortDate(iso: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
  });
}

function dayLabel(key: string) {
  const date = new Date(`${key}T00:00:00Z`);
  return {
    weekday: date.toLocaleDateString("en-PH", {
      weekday: "short",
      timeZone: "UTC",
    }),
    day: date.toLocaleDateString("en-PH", {
      day: "numeric",
      timeZone: "UTC",
    }),
  };
}

export default function AnalyticsPage() {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [daily, setDaily] = useState<Day[]>([]);
  const [insights, setInsights] = useState<PageInsights | null>(null);
  const [youtube, setYoutube] = useState<YouTubeInsights | null>(null);
  const [youtubeError, setYoutubeError] = useState(false);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [insightsError, setInsightsError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [range, setRange] = useState<AnalyticsRange>(DEFAULT_ANALYTICS_RANGE);
  const connection = useFacebookConnection();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analytics?days=${range}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        setTotals(data.totals ?? null);
        setDaily(Array.isArray(data.daily) ? data.daily : []);
        setLoadError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey, range]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/facebook/insights", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        setInsights(data);
        setInsightsError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setInsightsError(true);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/youtube/insights", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        // Not connected arrives as a 409 with the honest state in the body.
        const data = await res.json().catch(() => null);
        setYoutube(data ?? { connected: false });
        setYoutubeError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setYoutubeError(true);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/usage", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error("failed");
        setUsage(data as UsageResponse);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setUsage({
            openrouter: clientUsageUnavailable(),
            azure: clientUsageUnavailable(),
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setUsageLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const series = useMemo(() => {
    const byDay = new Map(daily.map((entry) => [entry.day, entry]));
    return lastNDays(range).map((day) => ({
      day,
      drafts: byDay.get(day)?.drafts ?? 0,
      published: byDay.get(day)?.published ?? 0,
      failed: byDay.get(day)?.failed ?? 0,
      scheduled: byDay.get(day)?.scheduled ?? 0,
    }));
  }, [daily, range]);

  const peak = Math.max(
    1,
    ...series.map(
      (entry) =>
        entry.drafts + entry.published + entry.scheduled + entry.failed
    )
  );

  const cards = [
    {
      label: "Published posts",
      value: totals?.published ?? 0,
      hint: "Delivered to the connected Page",
      icon: CircleCheck,
    },
    {
      label: "Scheduled",
      value: totals?.scheduled ?? 0,
      hint: "Queued and waiting to send",
      icon: CalendarClock,
    },
    {
      label: "Drafts created",
      value: totals?.drafts ?? 0,
      hint: "AI-assisted drafts in this workspace",
      icon: FileText,
    },
    {
      label: "Estimated AI spend",
      value: totals ? `$${totals.cost.toFixed(3)}` : "—",
      hint: totals
        ? `${totals.tokens.toLocaleString()} tokens used`
        : loadError
          ? "Couldn't load usage"
          : "No usage yet",
      icon: Sparkles,
    },
  ];

  function retryAnalytics() {
    setLoading(true);
    setUsageLoading(true);
    setLoadError(false);
    setReloadKey((key) => key + 1);
  }

  return (
    <AppFrame>
      <div className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:py-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Insights</p>
            <h1 className="page-title mt-1">Analytics</h1>
          </div>
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Date range"
              className="flex items-center rounded-[7px] border border-line-strong bg-card p-0.5"
            >
              {ANALYTICS_RANGES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={range === value}
                  onClick={() => {
                    if (value === range) return;
                    setLoading(true);
                    setRange(value);
                  }}
                  className={cn(
                    "h-8 rounded-[5px] px-2 text-[11.5px] font-semibold transition-colors",
                    range === value
                      ? "bg-ink text-paper"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {value}d
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              onClick={retryAnalytics}
              disabled={loading}
              aria-busy={loading}
              className="h-9 rounded-[7px] border-line-strong bg-card px-3 text-[12px]"
            >
              <RefreshCw
                className={cn("size-3.5", loading && "animate-spin")}
                aria-hidden
              />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            {connection.connected && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10.5px] font-semibold text-secondary-foreground">
                <span className="size-1.5 rounded-full bg-success" aria-hidden />
                {connection.page?.name ?? "Facebook Page"}
              </span>
            )}
          </div>
        </div>

        {totals?.failed ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            {totals.failed} scheduled post{totals.failed === 1 ? "" : "s"}{" "}
            failed to publish. Check the calendar for details.
          </div>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.label}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                    {card.label}
                  </p>
                  <Icon className="size-4 text-brand" aria-hidden />
                </div>
                <p className="mt-2 font-heading text-2xl font-semibold leading-none">
                  {loading || loadError ? "—" : card.value}
                </p>
                <p className="mt-1.5 text-[10.5px] text-muted-foreground">
                  {card.hint}
                </p>
              </div>
            );
          })}
        </div>

        <section className="mt-5" aria-labelledby="provider-usage-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2
                id="provider-usage-heading"
                className="text-[13px] font-semibold"
              >
                Provider usage
              </h2>
              <p className="text-[10.5px] text-muted-foreground">
                Live account credits and quotas · independent of workspace activity
              </p>
            </div>
            {usageLoading ? (
              <span
                role="status"
                className="text-[10.5px] text-muted-foreground"
              >
                Refreshing provider usage…
              </span>
            ) : null}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <OpenRouterUsageCard
              state={usage?.openrouter ?? null}
              loading={usageLoading}
            />
            <AzureUsageCard state={usage?.azure ?? null} loading={usageLoading} />
          </div>
        </section>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-3">
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[13px] font-semibold">Activity</h2>
                <p className="text-[10.5px] text-muted-foreground">
                  Drafts, publishes, failures and the queue per day
                </p>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <Legend className="bg-brand-soft" label="Drafts" />
                <Legend className="bg-brand" label="Published" />
                <Legend className="bg-destructive" label="Failed" />
                <Legend className="bg-ink/25" label="Scheduled" />
              </div>
            </div>

            {loadError ? (
              <ErrorState
                compact
                className="mt-4"
                title="Couldn't load activity"
                onRetry={retryAnalytics}
              />
            ) : (
              <div
                className={cn(
                  "mt-4 flex h-40 items-end",
                  range >= 30 ? "gap-[2px]" : "gap-1.5 sm:gap-2"
                )}
              >
              {series.map((entry, index) => {
                const total =
                  entry.drafts + entry.published + entry.scheduled + entry.failed;
                const scale = (value: number) => `${(value / peak) * 100}%`;
                const label = dayLabel(entry.day);
                // 14 columns fit two-line labels; denser ranges label sparsely
                // so the day numbers never collide.
                const labelStep = range <= 14 ? 1 : range <= 30 ? 2 : 7;
                const showLabel = (series.length - 1 - index) % labelStep === 0;
                return (
                  <div
                    key={entry.day}
                    className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1"
                    title={`${entry.day}: ${entry.drafts} drafts · ${entry.published} published · ${entry.failed} failed · ${entry.scheduled} scheduled`}
                  >
                    <div className="flex h-full w-full flex-col justify-end overflow-hidden rounded-t bg-surface-2">
                      {entry.scheduled > 0 && (
                        <div
                          className="w-full bg-ink/25"
                          style={{ height: scale(entry.scheduled) }}
                        />
                      )}
                      {entry.published > 0 && (
                        <div
                          className="w-full bg-brand"
                          style={{ height: scale(entry.published) }}
                        />
                      )}
                      {entry.failed > 0 && (
                        <div
                          className="w-full bg-destructive"
                          style={{ height: scale(entry.failed) }}
                        />
                      )}
                      {entry.drafts > 0 && (
                        <div
                          className="w-full bg-brand-soft"
                          style={{ height: scale(entry.drafts) }}
                        />
                      )}
                      {total === 0 && <div className="h-0.5 w-full bg-border" />}
                    </div>
                    <div
                      className={cn(
                        "text-center text-[9px] leading-tight text-muted-foreground",
                        !showLabel && "invisible"
                      )}
                    >
                      <p>{label.weekday}</p>
                      <p className="font-semibold text-muted-foreground">
                        {label.day}
                      </p>
                    </div>
                  </div>
                );
              })}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-[13px] font-semibold">Top posts</h2>
                <p className="text-[10.5px] text-muted-foreground">
                  Latest Facebook posts and how they landed
                </p>
              </div>
              {insights?.topPosts?.length ? (
                <Newspaper className="size-4 text-brand" aria-hidden />
              ) : null}
            </div>

            {insights?.topPosts?.length ? (
              <ul className="mt-3 flex flex-col gap-2">
                {insights.topPosts.map((post) => (
                  <li
                    key={post.id}
                    className="rounded-lg border border-border bg-surface-2 px-2.5 py-2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                        {shortDate(post.createdAt)}
                      </p>
                      <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
                        {post.reactions !== null && (
                          <span className="inline-flex items-center gap-1">
                            <Heart className="size-3" aria-hidden />
                            {post.reactions}
                          </span>
                        )}
                        {post.comments !== null && (
                          <span className="inline-flex items-center gap-1">
                            <MessageCircle className="size-3" aria-hidden />
                            {post.comments}
                          </span>
                        )}
                        {post.shares !== null && (
                          <span className="inline-flex items-center gap-1">
                            <Share2 className="size-3" aria-hidden />
                            {post.shares}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-foreground">
                      {post.message?.trim() || "(no text — media post)"}
                    </p>
                    {post.permalinkUrl && (
                      <a
                        href={post.permalinkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-[10px] font-semibold text-brand hover:underline"
                      >
                        View post
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {insights?.topPostsError
                  ? `Posts are unavailable right now: ${insights.topPostsError}`
                  : insights?.connected
                    ? "No published posts yet — publish one and it will show up here."
                    : "Connect a Facebook Page to see its posts."}
              </p>
            )}
          </section>
          </div>

          <div className="flex flex-col gap-3">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-[13px] font-semibold">Page audience</h2>
                  <p className="text-[10.5px] text-muted-foreground">
                    Live from Facebook Insights · last 7 days
                  </p>
                </div>
                {insights?.available && (
                  <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-success">
                    Live
                  </span>
                )}
              </div>

              {insights && !insights.connected ? (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Connect a Facebook Page to see its audience and engagement.
                </p>
              ) : insights && insights.available === false ? (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Insights are unavailable right now
                  {insights.reason ? `: ${insights.reason}` : "."}
                </p>
              ) : insightsError ? (
                <p className="mt-3 text-[11px] text-destructive">
                  Couldn&apos;t load Page insights. Try refreshing the page.
                </p>
              ) : (
                <dl className="mt-3 grid grid-cols-2 gap-3">
                  <Metric label="Followers" value={insights?.followers} />
                  <Metric label="Fans" value={insights?.fans} />
                  <Metric
                    label="Engagements"
                    value={insights?.engagements7d}
                  />
                  <Metric label="Media views" value={insights?.mediaViews7d} />
                </dl>
              )}
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <PlatformMark platform="instagram" className="size-3.5" />
                    Instagram
                  </h2>
                  <p className="text-[10.5px] text-muted-foreground">
                    {insights?.instagram?.username
                      ? `@${insights.instagram.username}`
                      : "Linked to your Facebook Page"}
                  </p>
                </div>
                {insights?.instagram && (
                  <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-success">
                    Live
                  </span>
                )}
              </div>

              {insights?.instagram ? (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    <Metric
                      label="Followers"
                      value={insights.instagram.followers}
                    />
                    <Metric
                      label="Posts"
                      value={insights.instagram.mediaCount}
                    />
                  </dl>
                  {insights.instagram.recent.length > 0 && (
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {insights.instagram.recent.slice(0, 3).map((post) => (
                        <li
                          key={post.id}
                          className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                              {shortDate(post.timestamp)}
                              {post.mediaType
                                ? ` · ${post.mediaType === "VIDEO" ? "Reel" : post.mediaType === "CAROUSEL_ALBUM" ? "Carousel" : "Post"}`
                                : ""}
                            </p>
                            <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
                              {post.likes !== null && (
                                <span className="inline-flex items-center gap-1">
                                  <Heart className="size-3" aria-hidden />
                                  {post.likes}
                                </span>
                              )}
                              {post.comments !== null && (
                                <span className="inline-flex items-center gap-1">
                                  <MessageCircle className="size-3" aria-hidden />
                                  {post.comments}
                                </span>
                              )}
                            </div>
                          </div>
                          {post.caption && (
                            <p className="mt-0.5 line-clamp-1 text-[10.5px] text-muted-foreground">
                              {post.caption}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  {insights?.instagramError
                    ? `Instagram insights are unavailable right now: ${insights.instagramError}`
                    : "No professional Instagram account is linked to your Facebook Pages yet."}
                </p>
              )}
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <PlatformMark platform="youtube" className="size-3.5" />
                    YouTube
                  </h2>
                  <p className="text-[10.5px] text-muted-foreground">
                    {youtube?.channel?.title ?? "Your YouTube channel"}
                  </p>
                </div>
                {youtube?.channel && (
                  <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-success">
                    Live
                  </span>
                )}
              </div>

              {youtube?.channel ? (
                <>
                  <dl className="mt-3 grid grid-cols-3 gap-3">
                    <Metric
                      label="Subscribers"
                      value={youtube.channel.subscriberCount}
                    />
                    <Metric label="Total views" value={youtube.channel.viewCount} />
                    <Metric label="Videos" value={youtube.channel.videoCount} />
                  </dl>
                  {youtube.recent && youtube.recent.length > 0 && (
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {youtube.recent.slice(0, 3).map((video) => (
                        <li
                          key={video.id}
                          className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                              {shortDate(video.publishedAt)}
                            </p>
                            <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
                              {video.views !== null && (
                                <span className="inline-flex items-center gap-1">
                                  <Eye className="size-3" aria-hidden />
                                  {video.views.toLocaleString()}
                                </span>
                              )}
                              {video.likes !== null && (
                                <span className="inline-flex items-center gap-1">
                                  <Heart className="size-3" aria-hidden />
                                  {video.likes}
                                </span>
                              )}
                            </div>
                          </div>
                          <a
                            href={video.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-0.5 line-clamp-1 text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {video.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  {youtubeError
                    ? "YouTube stats are unavailable right now."
                    : youtube?.reason
                      ? youtube.reason
                      : "Connect YouTube to see channel and upload stats."}
                </p>
              )}
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-[13px] font-semibold">Channels</h2>
            <p className="text-[10.5px] text-muted-foreground">
              Where this workspace can publish today
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              <li className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                <span className="grid size-7 place-items-center rounded-md bg-facebook text-[10px] font-bold text-white">
                  f
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11.5px] font-semibold">
                    Facebook Page
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {connection.loading
                      ? "Checking connection…"
                      : connection.connected
                        ? (connection.page?.name ?? "Connected")
                        : "Not connected"}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                    connection.connected
                      ? "bg-success/10 text-success"
                      : "bg-surface-3 text-muted-foreground"
                  )}
                >
                  {connection.connected ? "Live" : "Off"}
                </span>
              </li>
              {["Instagram", "X", "LinkedIn", "TikTok"].map((channel) => (
                <li
                  key={channel}
                  className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 opacity-70"
                >
                  <span className="grid size-7 place-items-center rounded-md bg-surface-3 text-[10px] font-bold text-muted-foreground">
                    {channel.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-semibold">
                      {channel}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Adapter planned
                    </p>
                  </div>
                  <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                    Soon
                  </span>
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

function ProviderStatusBadge({
  state,
  loading,
}: {
  state: UsageResult<unknown> | null;
  loading: boolean;
}) {
  const setup =
    state?.status === "unavailable" && state.code === "not_configured";
  const label = loading
    ? "Loading"
    : state?.status === "available"
      ? "Live"
      : setup
        ? "Setup needed"
        : "Unavailable";

  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
        loading || setup
          ? "bg-surface-3 text-muted-foreground"
          : state?.status === "available"
            ? "bg-success/10 text-success"
            : "bg-destructive/10 text-destructive"
      )}
    >
      {label}
    </span>
  );
}

function UsageSkeleton() {
  return (
    <div className="mt-4 space-y-3" role="status" aria-label="Loading usage">
      <span className="sr-only">Loading provider usage…</span>
      <div className="h-8 w-32 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="space-y-1.5">
            <div className="h-2.5 w-16 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <div className="h-4 w-12 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageUnavailableState({
  state,
}: {
  state: UsageResult<unknown> | null;
}) {
  const setup =
    state?.status === "unavailable" && state.code === "not_configured";
  return (
    <div
      className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-3"
      role="status"
    >
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold">
        <CircleAlert className="size-3.5 text-muted-foreground" aria-hidden />
        {setup ? "Setup needed" : "Usage unavailable"}
      </p>
      <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
        {state?.status === "unavailable"
          ? state.message
          : "Provider usage is temporarily unavailable. Try refreshing shortly."}
      </p>
    </div>
  );
}

function formatUsdUsage(value: number) {
  return `USD ${value.toLocaleString("en-PH", {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  })}`;
}

function formatUsageMoney(amount: Money | null) {
  if (!amount) return "—";
  const value = amount.value.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  return amount.currency ? `${amount.currency} ${value}` : value;
}

function formatUsageNumber(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-PH");
}

function formatUsageDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function upcomingCreditExpirations(lots: AzureCreditLot[]) {
  const now = Date.now();
  const terminalStatuses = new Set(["expired", "canceled", "cancelled", "complete"]);
  return lots
    .filter(
      (lot): lot is AzureCreditLot & { expirationDate: string } =>
        lot.expirationDate !== null &&
        Date.parse(lot.expirationDate) >= now &&
        !terminalStatuses.has(lot.status?.toLowerCase() ?? "")
    )
    .sort(
      (left, right) =>
        Date.parse(left.expirationDate) - Date.parse(right.expirationDate)
    );
}

function OpenRouterUsageCard({
  state,
  loading,
}: {
  state: UsageResult<OpenRouterUsage> | null;
  loading: boolean;
}) {
  const data = state?.status === "available" ? state.data : null;
  const showKeyLimits = data?.keyLimitUsd != null || data?.keyRemainingUsd != null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      aria-labelledby="openrouter-usage-title"
      aria-busy={loading}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <KeyRound className="size-4" aria-hidden />
          </span>
          <div>
            <h3
              id="openrouter-usage-title"
              className="text-[13px] font-semibold"
            >
              OpenRouter
            </h3>
            <p className="text-[10.5px] text-muted-foreground">
              Account key credits and free-tier quota
            </p>
          </div>
        </div>
        <ProviderStatusBadge state={state} loading={loading} />
      </div>

      {loading ? (
        <UsageSkeleton />
      ) : data ? (
        <>
          <div className="mt-4">
            <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Credits used
            </p>
            <p className="mt-1 font-heading text-2xl font-semibold leading-none">
              {formatUsdUsage(data.creditsUsedUsd)}
            </p>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
            <UsageMetric
              label="Daily free used"
              value={`${formatUsageNumber(data.dailyFreeRequests?.used ?? null)} / ${formatUsageNumber(data.dailyFreeRequests?.limit ?? null)}`}
            />
            <UsageMetric
              label="Daily free limit"
              value={formatUsageNumber(data.dailyFreeRequests?.limit ?? null)}
            />
            <UsageMetric
              label="Daily free remaining"
              value={formatUsageNumber(data.dailyFreeRequests?.remaining ?? null)}
            />
          </dl>
          {showKeyLimits ? (
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3">
              {data.keyLimitUsd !== null && (
                <UsageMetric
                  label="Key limit"
                  value={formatUsageMoney({
                    currency: "USD",
                    value: data.keyLimitUsd,
                  })}
                />
              )}
              {data.keyRemainingUsd !== null && (
                <UsageMetric
                  label="Key remaining"
                  value={formatUsageMoney({
                    currency: "USD",
                    value: data.keyRemainingUsd,
                  })}
                />
              )}
            </dl>
          ) : null}
        </>
      ) : (
        <UsageUnavailableState state={state} />
      )}
    </section>
  );
}

function AzureUsageCard({
  state,
  loading,
}: {
  state: UsageResult<AzureUsage> | null;
  loading: boolean;
}) {
  const data = state?.status === "available" ? state.data : null;
  const upcomingExpirations = data ? upcomingCreditExpirations(data.lots) : [];
  const nextExpiration = upcomingExpirations[0] ?? null;
  const expirationCount = upcomingExpirations.length;
  const balanceIsEstimated = data?.isEstimatedBalance === true;

  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      aria-labelledby="azure-usage-title"
      aria-busy={loading}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <Cloud className="size-4" aria-hidden />
          </span>
          <div>
            <h3 id="azure-usage-title" className="text-[13px] font-semibold">
              Azure
            </h3>
            <p className="text-[10.5px] text-muted-foreground">
              MCA credit balance and upcoming expiration
            </p>
          </div>
        </div>
        <ProviderStatusBadge state={state} loading={loading} />
      </div>

      {loading ? (
        <UsageSkeleton />
      ) : data ? (
        <>
          <div className="mt-4">
            <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              {balanceIsEstimated
                ? "Current credit balance (estimated)"
                : "Current credit balance"}
            </p>
            <p className="mt-1 font-heading text-2xl font-semibold leading-none">
              {formatUsageMoney(data.currentBalance)}
            </p>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border pt-3">
            <UsageMetric
              label="Azure-estimated balance"
              value={formatUsageMoney(data.estimatedBalance)}
            />
            <UsageMetric
              label="Pending eligible charges"
              value={formatUsageMoney(data.pendingEligibleCharges)}
            />
            <UsageMetric
              label="Expired credit"
              value={formatUsageMoney(data.expiredCredit)}
            />
            <UsageMetric
              label="Expiration"
              value={formatUsageDate(nextExpiration?.expirationDate ?? null)}
            />
          </dl>
          {balanceIsEstimated ? (
            <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
              Azure marks these balance details as estimates and subject to
              change.
            </p>
          ) : null}
          {nextExpiration ? (
            <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
              {nextExpiration.source ?? "Credit lot"}
              {nextExpiration.status ? ` · ${nextExpiration.status}` : ""}
              {expirationCount > 1
                ? ` · ${expirationCount} lots list an expiration`
                : ""}
            </p>
          ) : (
            <p className="mt-3 text-[10px] text-muted-foreground">
              No credit expiration was reported.
            </p>
          )}
        </>
      ) : (
        <UsageUnavailableState state={state} />
      )}
    </section>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words font-heading text-[13px] font-semibold leading-tight">
        {value}
      </dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value?: number | null }) {
  return (
    <div>
      <dt className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 font-heading text-lg font-semibold leading-none">
        {typeof value === "number" ? value.toLocaleString() : "—"}
      </dd>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("size-2 rounded-sm", className)} aria-hidden />
      {label}
    </span>
  );
}
