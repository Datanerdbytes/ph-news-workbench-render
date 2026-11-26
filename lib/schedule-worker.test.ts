import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/schedule-events", () => ({ recordScheduleEvent: vi.fn() }));
vi.mock("@/lib/facebook-page-token", () => ({
  getPrimaryPage: vi.fn(),
  resolvePageToken: vi.fn(),
}));
vi.mock("@/lib/facebook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/facebook")>();
  return {
    ...actual,
    publishPagePost: vi.fn(),
    isFacebookVideoPublished: vi.fn(),
    isFacebookPostPublished: vi.fn(),
    isFacebookLiveStarted: vi.fn(),
    isFacebookStillScheduled: vi.fn(),
    cancelFacebookScheduledPost: vi.fn(),
    rescheduleFacebookScheduledPost: vi.fn(),
  };
});
vi.mock("@/lib/publishing/connection", () => ({
  resolvePlatformAccount: vi.fn(),
}));
vi.mock("@/lib/publishing/instagram", () => ({
  publishInstagramImagePost: vi.fn(),
  resolveInstagramAccount: vi.fn(),
}));
vi.mock("@/lib/blob", () => ({ deleteStagedBlobs: vi.fn() }));
vi.mock("@/lib/publishing/videos", () => ({
  downloadVideoFromUrl: vi.fn(),
  publishPageVideo: vi.fn(),
}));
vi.mock("@/lib/youtube", () => ({
  ensureFreshYouTubeToken: vi.fn(),
  fetchYouTubeVideoStatus: vi.fn(),
}));

import { sql } from "@/lib/db";
import {
  FacebookApiError,
  cancelFacebookScheduledPost,
  isFacebookPostPublished,
  isFacebookStillScheduled,
  isFacebookVideoPublished,
  publishPagePost,
  rescheduleFacebookScheduledPost,
} from "@/lib/facebook";
import { getPrimaryPage, resolvePageToken } from "@/lib/facebook-page-token";
import { InstagramApiError } from "@/lib/instagram";
import { recordScheduleEvent } from "@/lib/schedule-events";
import { resolvePlatformAccount } from "@/lib/publishing/connection";
import {
  publishInstagramImagePost,
  resolveInstagramAccount,
} from "@/lib/publishing/instagram";
import { deleteStagedBlobs } from "@/lib/blob";
import {
  downloadVideoFromUrl,
  publishPageVideo,
} from "@/lib/publishing/videos";
import {
  ensureFreshYouTubeToken,
  fetchYouTubeVideoStatus,
} from "@/lib/youtube";
import {
  publishDuePosts,
  recoverStaleReschedules,
  syncNativeSchedules,
} from "./schedule-worker";

const sqlMock = sql as unknown as Mock;
const events = () =>
  vi.mocked(recordScheduleEvent).mock.calls.map((call) => call[0]);

/**
 * Dispatch mocked query results by their static SQL text: the claim query,
 * the stuck-publishing sweep, and the native-sync sweep each have a distinct
 * marker; every UPDATE returns nothing.
 */
function useDb(overrides: {
  claim?: unknown[];
  claimRow?: unknown[];
  stuck?: unknown[];
  native?: unknown[];
  staleRescheduling?: unknown[];
  updatedRows?: unknown[];
  completion?: unknown[];
  completionError?: Error;
}) {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (
      query.includes("WHERE status = 'rescheduling'") &&
      query.includes("interval '10 minutes'")
    )
      return overrides.staleRescheduling ?? [];
    if (query.includes("attempts = attempts + 1"))
      // Per-row conditional claim — succeeds unless the test overrides it.
      // attempts mirrors the fixture's pre-claim value + 1.
      return overrides.claimRow ?? [{ id: 1, attempts: 2 }];
    if (query.includes("source = 'local'")) return overrides.claim ?? [];
    if (query.includes("WITH published AS")) {
      if (overrides.completionError) throw overrides.completionError;
      return overrides.completion ?? overrides.updatedRows ?? [{ id: 1, avatar_blob_url: null }];
    }
    if (query.includes("RETURNING id"))
      return overrides.updatedRows ?? [{ id: 1 }];
    if (query.includes("status = 'publishing'")) return overrides.stuck ?? [];
    if (query.includes("source IN ('facebook', 'youtube')"))
      return overrides.native ?? [];
    return [];
  });
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_id: "ws1",
    news_item_id: null,
    draft_id: null,
    text: "hello",
    image_url: null,
    image_urls: null,
    avatar_job_id: null,
    attempts: 1,
    ...overrides,
  };
}

function nativeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_id: "ws1",
    news_item_id: null,
    kind: "post",
    source: "facebook",
    facebook_post_id: "fb_1",
    facebook_post_ids: null,
    page_id: "pg1",
    avatar_job_id: null,
    scheduled_for: minutesAgo(5),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDb({});
});

describe("publishDuePosts", () => {
  it("publishes a due post and records claimed + published events", async () => {
    useDb({ claim: [claimedRow({ draft_id: 21 })] });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });
    vi.mocked(publishPagePost).mockResolvedValue({
      id: "fb_1",
      permalink: null,
    });

    await expect(publishDuePosts({ source: "scheduler" })).resolves.toEqual({
      due: 1,
      published: 1,
      failed: 0,
      synced: 0,
    });

    expect(publishPagePost).toHaveBeenCalledWith({
      pageId: "pg1",
      accessToken: "tok",
      message: "hello",
      images: [],
      beforePublish: expect.any(Function),
    });
    expect(events().map((event) => event.event)).toEqual([
      "claimed",
      "published",
    ]);
    expect(events()[1]).toMatchObject({
      scheduledPostId: 1,
      facebookPostId: "fb_1",
      source: "scheduler",
    });

    const updateTexts = sqlMock.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(" ")
    );
    expect(
      updateTexts.some((text) => text.includes("SET status = 'published'"))
    ).toBe(true);
    expect(
      updateTexts.some((text) => text.includes("UPDATE drafts"))
    ).toBe(true);
  });

  it("requeues the post while attempts remain", async () => {
    // attempts is the pre-claim value; the per-row claim makes this the
    // second attempt.
    useDb({ claim: [claimedRow({ attempts: 1 })] });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });
    vi.mocked(publishPagePost).mockRejectedValue(
      new FacebookApiError("token expired", 190)
    );

    await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
      published: 0,
      failed: 0,
    });
    expect(events().map((event) => event.event)).toEqual([
      "claimed",
      "retrying",
    ]);
    expect(events()[1]).toMatchObject({
      errorMessage: "token expired",
      metadata: { attempt: 2, maxAttempts: 3 },
    });
  });

  it("fails the post once the attempt budget is exhausted", async () => {
    // attempts is the pre-claim value — the per-row claim makes this the
    // third attempt, which is the last one.
    useDb({
      claim: [claimedRow({ attempts: 2 })],
      claimRow: [{ id: 1, attempts: 3 }], // the claim lands the third attempt
    });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });
    vi.mocked(publishPagePost).mockRejectedValue(
      new FacebookApiError("token expired", 190)
    );

    await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
      published: 0,
      failed: 1,
    });
    expect(events().map((event) => event.event)).toEqual(["claimed", "failed"]);
  });

  it("skips a row another sweep already claimed", async () => {
    useDb({
      claim: [claimedRow()],
      claimRow: [], // the conditional claim updates nothing — contested
    });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });

    await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
      due: 1,
      published: 0,
      failed: 0,
    });
    expect(publishPagePost).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  it("skips a candidate rescheduled into the future before the publish claim", async () => {
    useDb({
      claim: [claimedRow()],
      claimRow: [], // the claim matches scheduled_for <= now(), returning empty when rescheduled
    });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });

    await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
      due: 1,
      published: 0,
      failed: 0,
    });
    expect(publishPagePost).not.toHaveBeenCalled();
    expect(events()).toEqual([]);

    const claimCalls = sqlMock.mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(" "))
      .filter((text) => text.includes("attempts = attempts + 1"));
    expect(claimCalls[0]).toContain("scheduled_for <= now()");
  });

  it("redacts token material from Facebook error messages", async () => {
    useDb({ claim: [claimedRow()] });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });
    vi.mocked(publishPagePost).mockRejectedValue(
      new FacebookApiError("failed: access_token=abc123", 190)
    );

    await publishDuePosts({ source: "scheduler" });
    expect(events()[1]).toMatchObject({
      errorMessage: "failed: access_token=[redacted]",
    });
  });

  it("reports a workspace with no connected page", async () => {
    useDb({ claim: [claimedRow()] });
    vi.mocked(getPrimaryPage).mockResolvedValue(null);

    await publishDuePosts({ source: "scheduler" });
    expect(events()[1]).toMatchObject({
      event: "retrying",
      errorMessage: "This workspace has no connected Facebook Page.",
    });
  });

  describe("scheduled avatar videos", () => {
    const avatarUrl = "https://blob.example/avatar-owned.mp4";
    const upload = {
      path: "/tmp/avatar.mp4",
      size: 10,
      type: "video/mp4",
      filename: "avatar.mp4",
    };

    function avatarRow(overrides: Record<string, unknown> = {}) {
      return claimedRow({
        kind: "video",
        image_url: avatarUrl,
        avatar_job_id: "avatar-1",
        ...overrides,
      });
    }

    beforeEach(() => {
      vi.mocked(getPrimaryPage).mockResolvedValue({ pageId: "pg1", token: "tok" });
      vi.mocked(downloadVideoFromUrl).mockResolvedValue({
        upload,
        cleanup: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(publishPageVideo).mockResolvedValue({ id: "fb_avatar", permalink: null });
    });

    it("atomically completes the avatar and deletes only the returned blob URL", async () => {
      useDb({
        claim: [avatarRow()],
        completion: [{ id: 1, avatar_blob_url: avatarUrl }],
      });

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toEqual({
        due: 1,
        published: 1,
        failed: 0,
        synced: 0,
      });

      const completionCall = sqlMock.mock.calls.find((call) =>
        (call[0] as TemplateStringsArray).join(" ").includes("WITH published AS")
      );
      const completionText = (completionCall![0] as TemplateStringsArray).join(" ");
      expect(completionText).toContain("UPDATE scheduled_posts");
      expect(completionText).toContain("SET status = 'published'");
      expect(completionText).toContain("UPDATE avatar_jobs");
      expect(completionText).toContain("publish_state = 'scheduled'");
      expect(completionText).toContain("SET publish_state = 'published'");
      expect(completionText).toContain("avatar_blob_url");
      expect(deleteStagedBlobs).toHaveBeenCalledTimes(1);
      expect(deleteStagedBlobs).toHaveBeenCalledWith([avatarUrl]);
      expect(events().map((event) => event.event)).toEqual(["claimed", "published"]);
      const persistIndex = sqlMock.mock.calls.findIndex((call) =>
        (call[0] as TemplateStringsArray).join(" ").includes("SET facebook_post_id =")
      );
      expect(persistIndex).toBeGreaterThanOrEqual(0);
      expect(sqlMock.mock.invocationCallOrder[persistIndex]).toBeLessThan(
        sqlMock.mock.invocationCallOrder[sqlMock.mock.calls.indexOf(completionCall!)]
      );
    });

    it("keeps avatar media when completion does not return its blob URL", async () => {
      useDb({
        claim: [avatarRow()],
        completion: [{ id: 1, avatar_blob_url: null }],
      });

      await publishDuePosts({ source: "scheduler" });

      expect(deleteStagedBlobs).not.toHaveBeenCalled();
    });

    it("never requeues after Graph success when the durable completion write fails", async () => {
      useDb({
        claim: [avatarRow()],
        completionError: new Error("database unavailable"),
      });

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
        due: 1,
        published: 1,
        failed: 0,
      });

      expect(publishPageVideo).toHaveBeenCalledTimes(1);
      expect(deleteStagedBlobs).not.toHaveBeenCalled();
      expect(events().map((event) => event.event)).toEqual(["claimed"]);
      const statusWrites = sqlMock.mock.calls.filter((call) => {
        const text = (call[0] as TemplateStringsArray).join(" ");
        return text.includes("UPDATE scheduled_posts") &&
          text.includes("SET status =") &&
          !text.includes("WITH published AS") &&
          !text.includes("attempts = attempts + 1");
      });
      expect(statusWrites).toEqual([]);
    });

    it("marks the video publish workflow before the external upload starts", async () => {
      useDb({ claim: [avatarRow()] });

      await publishDuePosts({ source: "scheduler" });

      expect(
        sqlMock.mock.calls.some((call) =>
          (call[0] as TemplateStringsArray).join(" ").includes("publish_started_at = now()")
        )
      ).toBe(true);
    });

    it("pauses retries and keeps avatar ownership after an ambiguous Graph failure", async () => {
      useDb({ claim: [avatarRow()] });
      vi.mocked(publishPageVideo).mockRejectedValue(
        new FacebookApiError("Facebook could not be reached.", undefined, true)
      );

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
        published: 0,
        failed: 0,
      });

      const pausedWrite = sqlMock.mock.calls.find((call) =>
        call.slice(1).some(
          (value) => typeof value === "string" && value.includes("Automatic retry is paused")
        )
      );
      expect(pausedWrite).toBeDefined();
      expect(deleteStagedBlobs).not.toHaveBeenCalled();
      expect(
        sqlMock.mock.calls.some((call) =>
          (call[0] as TemplateStringsArray).join(" ").includes("UPDATE avatar_jobs SET publish_state = 'ready'")
        )
      ).toBe(false);
      expect(events().map((event) => event.event)).toEqual(["claimed"]);
    });

    it("keeps a terminally failed avatar scheduled while its failed row references it", async () => {
      useDb({
        claim: [avatarRow({ attempts: 2 })],
        claimRow: [{ id: 1, attempts: 3 }],
      });
      vi.mocked(publishPageVideo).mockRejectedValue(new Error("Facebook refused"));

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
        published: 0,
        failed: 1,
      });

      expect(
        sqlMock.mock.calls.some((call) =>
          (call[0] as TemplateStringsArray).join(" ").includes("UPDATE avatar_jobs SET publish_state = 'ready'")
        )
      ).toBe(false);
      expect(events().map((event) => event.event)).toEqual(["claimed", "failed"]);
    });

    it("leaves the avatar scheduled when a failed publish will be requeued", async () => {
      useDb({
        claim: [avatarRow({ attempts: 1 })],
        claimRow: [{ id: 1, attempts: 2 }],
        updatedRows: [{ id: 1, avatar_job_id: "avatar-1" }],
      });
      vi.mocked(publishPageVideo).mockRejectedValue(new Error("temporary failure"));

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
        published: 0,
        failed: 0,
      });

      expect(
        sqlMock.mock.calls.some((call) =>
          (call[0] as TemplateStringsArray).join(" ").includes("UPDATE avatar_jobs SET publish_state = 'ready'")
        )
      ).toBe(false);
      expect(events().map((event) => event.event)).toEqual(["claimed", "retrying"]);
    });

    it("never requeues a started publish whose platform id was not persisted", async () => {
      useDb({
        stuck: [
          {
            id: 1,
            workspace_id: "ws1",
            news_item_id: null,
            attempts: 1,
            facebook_post_id: null,
            publish_started_at: minutesAgo(10),
            kind: "video",
            avatar_job_id: "avatar-1",
          },
        ],
      });

      await publishDuePosts({ source: "scheduler" });

      expect(resolvePageToken).not.toHaveBeenCalled();
      expect(
        sqlMock.mock.calls.some((call) => {
          const text = (call[0] as TemplateStringsArray).join(" ");
          return text.includes("SET status =") && text.includes("scheduled");
        })
      ).toBe(false);
      expect(deleteStagedBlobs).not.toHaveBeenCalled();
    });

    it("never requeues a stored platform id when publication is not confirmed", async () => {
      useDb({
        stuck: [
          {
            id: 1,
            workspace_id: "ws1",
            news_item_id: null,
            attempts: 1,
            facebook_post_id: "fb_avatar",
            publish_started_at: minutesAgo(10),
            kind: "video",
            avatar_job_id: "avatar-1",
          },
        ],
      });
      vi.mocked(resolvePageToken).mockResolvedValue("tok");
      vi.mocked(isFacebookVideoPublished).mockResolvedValue(false);

      await publishDuePosts({ source: "scheduler" });

      expect(
        sqlMock.mock.calls.some((call) => {
          const text = (call[0] as TemplateStringsArray).join(" ");
          return text.includes("SET status =") && text.includes("scheduled");
        })
      ).toBe(false);
      expect(deleteStagedBlobs).not.toHaveBeenCalled();
    });

    it("requeues an interrupted row only when no external publish began", async () => {
      useDb({
        stuck: [
          {
            id: 1,
            workspace_id: "ws1",
            news_item_id: null,
            attempts: 1,
            facebook_post_id: null,
            publish_started_at: null,
            kind: "video",
            avatar_job_id: "avatar-1",
          },
        ],
      });

      await publishDuePosts({ source: "scheduler" });

      expect(events()[0]).toMatchObject({ event: "retrying" });
      expect(resolvePageToken).not.toHaveBeenCalled();
    });

    it("marks a recovered publishing row and its avatar published when Facebook confirms it", async () => {
      useDb({
        stuck: [
          {
            id: 1,
            workspace_id: "ws1",
            news_item_id: null,
            attempts: 1,
            facebook_post_id: "fb_avatar",
            kind: "video",
            avatar_job_id: "avatar-1",
          },
        ],
        completion: [{ id: 1, avatar_blob_url: avatarUrl }],
      });
      vi.mocked(resolvePageToken).mockResolvedValue("tok");
      vi.mocked(isFacebookVideoPublished).mockResolvedValue(true);

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toMatchObject({
        due: 0,
        published: 0,
        failed: 0,
      });

      expect(deleteStagedBlobs).toHaveBeenCalledWith([avatarUrl]);
      expect(events()[0]).toMatchObject({
        event: "published",
        facebookPostId: "fb_avatar",
        metadata: expect.objectContaining({ recovered: true }),
      });
      expect(
        sqlMock.mock.calls.some((call) =>
          (call[0] as TemplateStringsArray).join(" ").includes("SET publish_state = 'published'")
        )
      ).toBe(true);
    });
  });

  describe("scheduled Instagram posts", () => {
    const igImage =
      "https://bucket.public.blob.vercel-storage.com/instagram/img.jpg";

    function instagramRow(overrides: Record<string, unknown> = {}) {
      return claimedRow({
        kind: "instagram-post",
        image_url: igImage,
        ...overrides,
      });
    }

    const igConnection = {
      ok: true as const,
      account: { id: "ig1", username: "iamwowie_", picture: null },
      accessToken: "page-token",
      scopes: ["instagram_content_publish"],
      pageId: "pg1",
    };

    beforeEach(() => {
      vi.mocked(resolveInstagramAccount).mockResolvedValue(igConnection);
      vi.mocked(publishInstagramImagePost).mockResolvedValue({
        id: "ig_media_1",
        permalink: "https://www.instagram.com/p/xyz",
      });
    });

    it("publishes via the container flow and deletes the staged image", async () => {
      useDb({ claim: [instagramRow({ draft_id: 31 })] });

      await expect(publishDuePosts({ source: "scheduler" })).resolves.toEqual({
        due: 1,
        published: 1,
        failed: 0,
        synced: 0,
      });

      expect(resolveInstagramAccount).toHaveBeenCalledWith("ws1");
      expect(publishInstagramImagePost).toHaveBeenCalledWith({
        account: igConnection.account,
        accessToken: "page-token",
        imageUrl: igImage,
        caption: "hello",
        beforePublish: expect.any(Function),
      });
      expect(deleteStagedBlobs).toHaveBeenCalledWith([igImage]);
      expect(events().map((event) => event.event)).toEqual([
        "claimed",
        "published",
      ]);
      expect(events()[1]).toMatchObject({
        event: "published",
        facebookPostId: "ig_media_1",
      });

      const updateTexts = sqlMock.mock.calls.map((call) =>
        (call[0] as TemplateStringsArray).join(" ")
      );
      expect(
        updateTexts.some((text) => text.includes("status = 'published'"))
      ).toBe(true);
      expect(
        updateTexts.some((text) => text.includes("UPDATE drafts"))
      ).toBe(true);
    });

    it("retries with the gate message when no Instagram account is linked", async () => {
      useDb({ claim: [instagramRow()] });
      vi.mocked(resolveInstagramAccount).mockResolvedValue({
        ok: false,
        reason: "no_ig_account",
        detail: "This Page has no professional Instagram account linked to it.",
      });

      await publishDuePosts({ source: "scheduler" });

      expect(publishInstagramImagePost).not.toHaveBeenCalled();
      expect(deleteStagedBlobs).not.toHaveBeenCalled();
      expect(events()[1]).toMatchObject({
        event: "retrying",
        errorMessage:
          "This Page has no professional Instagram account linked to it.",
      });
    });

    it("pauses retries when Instagram may have accepted the publish", async () => {
      useDb({ claim: [instagramRow()] });
      vi.mocked(publishInstagramImagePost).mockRejectedValue(
        new InstagramApiError("Instagram could not be reached.", undefined, true)
      );

      await publishDuePosts({ source: "scheduler" });

      expect(events().map((event) => event.event)).toEqual(["claimed"]);
      expect(deleteStagedBlobs).not.toHaveBeenCalled();
      expect(
        sqlMock.mock.calls.some((call) =>
          call.slice(1).some(
            (value) => typeof value === "string" && value.includes("Automatic retry is paused")
          )
        )
      ).toBe(true);
    });

    it("retries when Instagram refuses the publish", async () => {
      useDb({ claim: [instagramRow()] });
      vi.mocked(publishInstagramImagePost).mockRejectedValue(
        new Error("Instagram is still processing the image. Retry shortly.")
      );

      await publishDuePosts({ source: "scheduler" });

      expect(events()[1]).toMatchObject({
        event: "retrying",
        errorMessage: "Instagram is still processing the image. Retry shortly.",
      });
    });
  });
});

describe("syncNativeSchedules", () => {
  it("returns zero when no native rows are due", async () => {
    await expect(syncNativeSchedules()).resolves.toBe(0);
    expect(recordScheduleEvent).not.toHaveBeenCalled();
  });

  it("marks a post published when Facebook reports it live", async () => {
    useDb({ native: [nativeRow()] });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookPostPublished).mockResolvedValue(true);

    await expect(syncNativeSchedules()).resolves.toBe(1);
    expect(events()[0]).toMatchObject({
      event: "published",
      facebookPostId: "fb_1",
      metadata: { kind: "post", executor: "facebook" },
    });
  });

  it("completes a linked avatar when a native row is confirmed published", async () => {
    useDb({
      native: [nativeRow({ avatar_job_id: "avatar-1" })],
      completion: [{ id: 1, avatar_blob_url: "https://blob.example/avatar.mp4" }],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookPostPublished).mockResolvedValue(true);

    await expect(syncNativeSchedules()).resolves.toBe(1);

    expect(deleteStagedBlobs).toHaveBeenCalledWith([
      "https://blob.example/avatar.mp4",
    ]);
    expect(
      sqlMock.mock.calls.some((call) =>
        (call[0] as TemplateStringsArray).join(" ").includes("SET publish_state = 'published'")
      )
    ).toBe(true);
  });

  it("tries the next probe shape when one is inconclusive", async () => {
    useDb({ native: [nativeRow({ kind: "reel" })] });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookVideoPublished).mockResolvedValue(null);
    vi.mocked(isFacebookPostPublished).mockResolvedValue(true);

    await expect(syncNativeSchedules()).resolves.toBe(1);
  });

  it("falls through to the next probe when one throws", async () => {
    useDb({ native: [nativeRow()] });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookPostPublished).mockRejectedValue(
      new FacebookApiError("boom", 500)
    );
    vi.mocked(isFacebookVideoPublished).mockResolvedValue(true);

    await expect(syncNativeSchedules()).resolves.toBe(1);
  });

  it("infers publication from the scheduled_posts queue for containers", async () => {
    useDb({
      native: [nativeRow({ kind: "reel", scheduled_for: minutesAgo(5) })],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookVideoPublished).mockResolvedValue(null);
    vi.mocked(isFacebookPostPublished).mockResolvedValue(null);
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(false);

    await expect(syncNativeSchedules()).resolves.toBe(1);
    expect(events()[0]).toMatchObject({
      event: "published",
      metadata: { executor: "facebook", viaQueue: true },
    });
  });

  it("fails items removed from the queue before their slot", async () => {
    useDb({
      native: [
        nativeRow({
          kind: "reel",
          scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      ],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookVideoPublished).mockResolvedValue(null);
    vi.mocked(isFacebookPostPublished).mockResolvedValue(null);
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(false);

    await expect(syncNativeSchedules()).resolves.toBe(1);
    expect(events()[0]).toMatchObject({
      event: "failed",
      errorMessage: "The item was removed from Facebook before its scheduled time.",
    });
  });

  it("leaves items Facebook is still holding", async () => {
    useDb({ native: [nativeRow({ kind: "reel" })] });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookVideoPublished).mockResolvedValue(null);
    vi.mocked(isFacebookPostPublished).mockResolvedValue(null);
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);

    await expect(syncNativeSchedules()).resolves.toBe(0);
    expect(recordScheduleEvent).not.toHaveBeenCalled();
  });

  it("fails items that stayed unpublished past their grace period", async () => {
    useDb({
      native: [
        nativeRow({
          page_id: null,
          scheduled_for: minutesAgo(3 * 60),
        }),
      ],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookPostPublished).mockResolvedValue(null);
    vi.mocked(isFacebookVideoPublished).mockResolvedValue(null);

    await expect(syncNativeSchedules()).resolves.toBe(1);
    expect(events()[0]).toMatchObject({
      event: "failed",
      errorMessage: "Facebook did not publish this item at its scheduled time.",
    });
  });

  it("reports rows without a Facebook id as failed without counting them", async () => {
    useDb({ native: [nativeRow({ facebook_post_id: null })] });

    await expect(syncNativeSchedules()).resolves.toBe(0);
    expect(events()[0]).toMatchObject({
      event: "failed",
      errorMessage: "Facebook did not return an id for this item.",
    });
  });

  describe("YouTube-scheduled videos", () => {
    function youtubeRow(overrides: Record<string, unknown> = {}) {
      return nativeRow({
        kind: "video",
        source: "youtube",
        facebook_post_id: "yt_video_1",
        page_id: "UC1",
        ...overrides,
      });
    }

    const connectedAccount = {
      platform: "youtube" as const,
      platformUserId: "UC1",
      username: "Neural-Verse",
      accessToken: "cipher-token",
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
      expiresAt: null,
    };

    beforeEach(() => {
      vi.mocked(resolvePlatformAccount).mockResolvedValue(connectedAccount);
      vi.mocked(ensureFreshYouTubeToken).mockResolvedValue("fresh-token");
    });

    it("marks the video published once YouTube flips it public", async () => {
      useDb({ native: [youtubeRow()] });
      vi.mocked(fetchYouTubeVideoStatus).mockResolvedValue({
        uploadStatus: "processed",
        thumbnail: null,
        privacyStatus: "public",
      });

      await expect(syncNativeSchedules()).resolves.toBe(1);
      expect(ensureFreshYouTubeToken).toHaveBeenCalledWith(
        connectedAccount,
        "ws1"
      );
      expect(fetchYouTubeVideoStatus).toHaveBeenCalledWith(
        "yt_video_1",
        "fresh-token"
      );
      expect(events()[0]).toMatchObject({
        event: "published",
        facebookPostId: "yt_video_1",
        metadata: { kind: "video", executor: "youtube" },
      });
    });

    it("leaves the row scheduled while the video is still private", async () => {
      useDb({ native: [youtubeRow()] });
      vi.mocked(fetchYouTubeVideoStatus).mockResolvedValue({
        uploadStatus: "processed",
        thumbnail: null,
        privacyStatus: "private",
      });

      await expect(syncNativeSchedules()).resolves.toBe(0);
      expect(events()).toEqual([]);
    });

    it("fails the row once it stays private past the grace period", async () => {
      useDb({
        native: [youtubeRow({ scheduled_for: minutesAgo(90) })],
      });
      vi.mocked(fetchYouTubeVideoStatus).mockResolvedValue({
        uploadStatus: "processed",
        thumbnail: null,
        privacyStatus: "private",
      });

      await expect(syncNativeSchedules()).resolves.toBe(1);
      expect(events()[0]).toMatchObject({
        event: "failed",
        errorMessage:
          "YouTube did not publish this video at its scheduled time.",
        metadata: { kind: "video", executor: "youtube" },
      });
    });

    it("keeps inconclusive probe results retryable and never fails on them", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      useDb({
        native: [youtubeRow({ scheduled_for: minutesAgo(90) })],
      });
      // Non-OK responses surface as null — the video may already be public.
      vi.mocked(fetchYouTubeVideoStatus).mockResolvedValue({
        uploadStatus: null,
        thumbnail: null,
        privacyStatus: null,
      });

      await expect(syncNativeSchedules()).resolves.toBe(0);
      expect(events()).toEqual([]);

      // The back-off marker bumps updated_at so the row skips the next
      // sweep instead of occupying the LIMIT 10 slot every run.
      const updateTexts = sqlMock.mock.calls.map((call) =>
        (call[0] as TemplateStringsArray).join(" ")
      );
      expect(
        updateTexts.some((text) => text.includes("SET updated_at = now()"))
      ).toBe(true);
      expect(errorSpy.mock.calls[0][0]).toContain("probe_failed");
    });

    it("backs off within the grace window when the probe errors", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      useDb({ native: [youtubeRow()] });
      vi.mocked(ensureFreshYouTubeToken).mockRejectedValue(
        new Error("Google could not be reached.")
      );

      await expect(syncNativeSchedules()).resolves.toBe(0);
      expect(events()).toEqual([]);

      const updateTexts = sqlMock.mock.calls.map((call) =>
        (call[0] as TemplateStringsArray).join(" ")
      );
      expect(
        updateTexts.some((text) => text.includes("SET updated_at = now()"))
      ).toBe(true);
      expect(errorSpy.mock.calls[0][0]).toContain("probe_failed");
    });

    it("fails a row it cannot probe once the grace window passes", async () => {
      useDb({
        native: [youtubeRow({ scheduled_for: minutesAgo(90) })],
      });
      vi.mocked(ensureFreshYouTubeToken).mockRejectedValue(
        new Error("Google could not be reached.")
      );

      await expect(syncNativeSchedules()).resolves.toBe(1);
      expect(events()[0]).toMatchObject({
        event: "failed",
        errorMessage:
          "YouTube could not be probed: Google could not be reached.",
        metadata: { kind: "video", executor: "youtube" },
      });
    });

    it("fails the row when the YouTube connection is gone", async () => {
      useDb({ native: [youtubeRow()] });
      vi.mocked(resolvePlatformAccount).mockResolvedValue(null);

      await expect(syncNativeSchedules()).resolves.toBe(1);
      expect(fetchYouTubeVideoStatus).not.toHaveBeenCalled();
      expect(events()[0]).toMatchObject({
        event: "failed",
        errorMessage: "The YouTube connection is gone. Reconnect YouTube.",
      });
    });

    it("fails rows without a stored video id", async () => {
      useDb({ native: [youtubeRow({ facebook_post_id: null })] });

      await expect(syncNativeSchedules()).resolves.toBe(1);
      expect(resolvePlatformAccount).not.toHaveBeenCalled();
      expect(events()[0]).toMatchObject({
        event: "failed",
        errorMessage: "YouTube did not return an id for this upload.",
      });
    });

    describe("stale rescheduling claim recovery", () => {
      it("resets a stale rescheduling claim older than 10 minutes to scheduled with confirmed intended time", async () => {
        const intendedTime = minutesAgo(-120);
        useDb({
          staleRescheduling: [
            {
              id: 42,
              workspace_id: "ws1",
              source: "facebook",
              kind: "post",
              facebook_post_id: "fb_stale",
              page_id: "pg1",
              scheduled_for: minutesAgo(30),
              error_message: JSON.stringify({
                claim: "c1",
                intended: intendedTime,
              }),
            },
          ],
        });
        vi.mocked(resolvePageToken).mockResolvedValue("tok");
        vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);

        await syncNativeSchedules();

        const updateCalls = sqlMock.mock.calls
          .map((call) => (call[0] as TemplateStringsArray).join(" "))
          .filter(
            (text) =>
              text.includes("SET status = 'scheduled'") &&
              text.includes("status = 'rescheduling'")
          );
        expect(updateCalls.length).toBeGreaterThan(0);
      });

      it("leaves a recent rescheduling row unchanged", async () => {
        // Query for stale rescheduling claims older than 10 minutes returns empty
        useDb({ staleRescheduling: [] });

        await syncNativeSchedules();

        const updateCalls = sqlMock.mock.calls
          .map((call) => (call[0] as TemplateStringsArray).join(" "))
          .filter(
            (text) =>
              text.includes("SET status = 'scheduled'") &&
              text.includes("status = 'rescheduling'")
          );
        expect(updateCalls).toHaveLength(0);
      });

      it("does not fail a post if it was rescheduled while the probe was in flight", async () => {
        useDb({
          native: [nativeRow({ scheduled_for: minutesAgo(90) })],
          // Conditional update matches scheduled_for, simulating row moved by concurrent PATCH
          updatedRows: [],
        });

        await expect(syncNativeSchedules()).resolves.toBe(0);
        expect(events()).toEqual([]);
      });
    });
  });
});

describe("recoverStaleReschedules", () => {
  /**
   * Dispatch mocked query results by their static SQL text: the stale-claim
   * SELECT, the ownership swap, the deletion, and the claim release each have
   * a distinctive shape.
   */
  function useRecoveryDb(
    overrides: {
      staleRescheduling?: unknown[];
      ownership?: unknown[];
      deleted?: unknown[];
      released?: unknown[];
    } = {}
  ) {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (
        query.includes("WHERE status = 'rescheduling'") &&
        query.includes("interval '10 minutes'")
      )
        return overrides.staleRescheduling ?? [];
      if (query.includes("SET error_message =") && !query.includes("SET status"))
        return overrides.ownership ?? [{ id: 1 }];
      if (query.includes("DELETE FROM scheduled_posts"))
        return overrides.deleted ?? [];
      if (query.includes("SET status = 'scheduled'"))
        return overrides.released ?? [{ id: 1 }];
      return [];
    });
  }

  const staleRow = (overrides: Record<string, unknown> = {}) => ({
    id: 42,
    workspace_id: "ws1",
    source: "facebook",
    kind: "post",
    facebook_post_id: null,
    facebook_post_ids: null,
    page_id: null,
    scheduled_for: minutesAgo(30),
    error_message: null,
    ...overrides,
  });

  const queryText = (call: unknown[]) =>
    (call[0] as TemplateStringsArray).join(" ");

  const releaseCalls = () =>
    sqlMock.mock.calls.filter((call) =>
      queryText(call).includes("SET status = 'scheduled'")
    );

  const deleteCalls = () =>
    sqlMock.mock.calls.filter((call) =>
      queryText(call).includes("DELETE FROM scheduled_posts")
    );

  it("moves every Page to the intended time before releasing the claim", async () => {
    const intended = minutesAgo(-120);
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          facebook_post_ids: [
            { ok: true, id: "p1", page: { id: "pg1", name: "One" } },
            { ok: true, id: "p2", page: { id: "pg2", name: "Two" } },
          ],
          error_message: JSON.stringify({ claim: "c1", intended }),
        }),
      ],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);

    await expect(recoverStaleReschedules()).resolves.toBe(1);

    expect(vi.mocked(rescheduleFacebookScheduledPost)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rescheduleFacebookScheduledPost)).toHaveBeenNthCalledWith(
      1,
      "p1",
      "tok",
      Math.floor(new Date(intended).getTime() / 1000),
      "pg1"
    );
    expect(vi.mocked(rescheduleFacebookScheduledPost)).toHaveBeenNthCalledWith(
      2,
      "p2",
      "tok",
      Math.floor(new Date(intended).getTime() / 1000),
      "pg2"
    );
    expect(releaseCalls()[0][1]).toBe(intended);
  });

  it("keeps the claim while any Page remains unconfirmed at the intended time", async () => {
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          facebook_post_ids: [
            { ok: true, id: "p1", page: { id: "pg1", name: "One" } },
            { ok: true, id: "p2", page: { id: "pg2", name: "Two" } },
          ],
          error_message: JSON.stringify({
            claim: "c1",
            intended: minutesAgo(-120),
          }),
        }),
      ],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);
    vi.mocked(rescheduleFacebookScheduledPost)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("graph down"));

    await expect(recoverStaleReschedules()).resolves.toBe(0);

    expect(releaseCalls()).toHaveLength(0);
  });

  it("restores the old time for a Facebook row with no accepted targets", async () => {
    const old = minutesAgo(30);
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          scheduled_for: old,
          error_message: JSON.stringify({
            claim: "c1",
            intended: minutesAgo(-120),
          }),
        }),
      ],
    });

    await expect(recoverStaleReschedules()).resolves.toBe(1);

    expect(resolvePageToken).not.toHaveBeenCalled();
    expect(releaseCalls()[0][1]).toBe(old);
  });

  it("restores the confirmed intended time for a row no platform holds", async () => {
    const intended = minutesAgo(-120);
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          source: "local",
          error_message: JSON.stringify({ claim: "c1", intended }),
        }),
      ],
    });

    await expect(recoverStaleReschedules()).resolves.toBe(1);

    expect(resolvePageToken).not.toHaveBeenCalled();
    expect(releaseCalls()[0][1]).toBe(intended);
  });

  it("skips a row whose claim was taken by another sweep before the swap", async () => {
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          error_message: JSON.stringify({
            claim: "c1",
            intended: minutesAgo(-120),
          }),
        }),
      ],
      ownership: [],
    });

    await expect(recoverStaleReschedules()).resolves.toBe(0);

    expect(resolvePageToken).not.toHaveBeenCalled();
    expect(rescheduleFacebookScheduledPost).not.toHaveBeenCalled();
    expect(releaseCalls()).toHaveLength(0);
  });

  it("takes exclusive ownership of the claim before any remote call", async () => {
    const observed = JSON.stringify({
      claim: "c1",
      intended: minutesAgo(-120),
    });
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          facebook_post_id: "fb_1",
          page_id: "pg1",
          error_message: observed,
        }),
      ],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);

    await recoverStaleReschedules();

    const swapIndex = sqlMock.mock.calls.findIndex((call) =>
      queryText(call).includes("SET error_message =")
    );
    expect(swapIndex).toBeGreaterThanOrEqual(0);
    const swap = sqlMock.mock.calls[swapIndex];
    expect(swap[2]).toBe(42);
    expect(swap[3]).toBe(observed);
    expect(sqlMock.mock.invocationCallOrder[swapIndex]).toBeLessThan(
      vi.mocked(resolvePageToken).mock.invocationCallOrder[0]
    );
  });

  it("deletes a claimed row only after confirming the remote cancellation on every Page", async () => {
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          facebook_post_ids: [
            { ok: true, id: "p1", page: { id: "pg1", name: "One" } },
            { ok: true, id: "p2", page: { id: "pg2", name: "Two" } },
          ],
          error_message: JSON.stringify({ claim: "c1", action: "delete" }),
        }),
      ],
      deleted: [{ id: 42, news_item_id: 7, scheduled_for: minutesAgo(30) }],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);

    await recoverStaleReschedules();

    expect(vi.mocked(cancelFacebookScheduledPost)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cancelFacebookScheduledPost)).toHaveBeenNthCalledWith(
      1,
      "p1",
      "tok",
      "pg1"
    );
    expect(vi.mocked(cancelFacebookScheduledPost)).toHaveBeenNthCalledWith(
      2,
      "p2",
      "tok",
      "pg2"
    );
    expect(deleteCalls()).toHaveLength(1);
    expect(events()).toEqual([
      expect.objectContaining({
        event: "canceled",
        metadata: expect.objectContaining({ recovered: true }),
      }),
    ]);
  });

  it("releases an avatar after recovering a durable local deletion", async () => {
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          source: "local",
          avatar_job_id: "avatar-1",
          error_message: JSON.stringify({ claim: "c1", action: "delete" }),
        }),
      ],
      deleted: [
        {
          id: 42,
          news_item_id: 7,
          scheduled_for: minutesAgo(30),
          avatar_job_id: "avatar-1",
        },
      ],
    });

    await expect(recoverStaleReschedules()).resolves.toBe(1);

    expect((deleteCalls()[0][0] as TemplateStringsArray).join(" ")).toContain(
      "RETURNING id, news_item_id, scheduled_for, avatar_job_id"
    );
    const releaseCall = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("UPDATE avatar_jobs SET publish_state = 'ready'")
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall).toContain("avatar-1");
    expect(releaseCall).toContain("ws1");
  });

  it("deletes without re-canceling a Page Facebook no longer holds", async () => {
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          facebook_post_id: "fb_1",
          page_id: "pg1",
          error_message: JSON.stringify({ claim: "c1", action: "delete" }),
        }),
      ],
      deleted: [{ id: 42, news_item_id: 7, scheduled_for: minutesAgo(30) }],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(false);

    await recoverStaleReschedules();

    expect(vi.mocked(cancelFacebookScheduledPost)).not.toHaveBeenCalled();
    expect(deleteCalls()).toHaveLength(1);
  });

  it("puts a claimed row back to scheduled when a Page cannot be confirmed canceled", async () => {
    useRecoveryDb({
      staleRescheduling: [
        staleRow({
          facebook_post_id: "fb_1",
          page_id: "pg1",
          error_message: JSON.stringify({ claim: "c1", action: "delete" }),
        }),
      ],
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok");
    vi.mocked(isFacebookStillScheduled).mockResolvedValue(true);
    vi.mocked(cancelFacebookScheduledPost).mockRejectedValue(
      new Error("graph refused")
    );

    await recoverStaleReschedules();

    expect(deleteCalls()).toHaveLength(0);
    expect(events()).toEqual([]);
    expect(releaseCalls()).toHaveLength(1);
  });
});

describe("publishDuePosts video posts", () => {
  it("publishes the staged video with the post text as its description", async () => {
    useDb({
      claim: [
        claimedRow({
          kind: "video",
          image_url: "https://blob.example/v1.mp4",
          page_id: "pg2",
          text: "Story text",
        }),
      ],
    });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });
    vi.mocked(resolvePageToken).mockResolvedValue("tok2");
    const cleanup = vi.fn();
    const upload = {
      path: "/tmp/v.mp4",
      size: 10,
      type: "video/mp4",
      filename: "v1.mp4",
    };
    vi.mocked(downloadVideoFromUrl).mockResolvedValue({
      upload,
      cleanup,
    });
    vi.mocked(publishPageVideo).mockResolvedValue({
      id: "fb_v1",
      permalink: null,
    });

    await expect(
      publishDuePosts({ source: "scheduler" })
    ).resolves.toEqual({ due: 1, published: 1, failed: 0, synced: 0 });

    expect(downloadVideoFromUrl).toHaveBeenCalledWith(
      "https://blob.example/v1.mp4"
    );
    expect(publishPageVideo).toHaveBeenCalledWith({
      pageId: "pg2",
      accessToken: "tok2",
      description: "Story text",
      video: upload,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(deleteStagedBlobs).toHaveBeenCalledWith([
      "https://blob.example/v1.mp4",
    ]);
    expect(events().map((event) => event.event)).toEqual([
      "claimed",
      "published",
    ]);
  });

  it("publishes to the primary Page when the row picked none", async () => {
    useDb({
      claim: [
        claimedRow({
          kind: "video",
          image_url: "https://blob.example/v1.mp4",
          text: "Story text",
        }),
      ],
    });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });
    vi.mocked(downloadVideoFromUrl).mockResolvedValue({
      upload: {
        path: "/tmp/v.mp4",
        size: 10,
        type: "video/mp4",
        filename: "v1.mp4",
      },
      cleanup: vi.fn(),
    });
    vi.mocked(publishPageVideo).mockResolvedValue({
      id: "fb_v1",
      permalink: null,
    });

    await publishDuePosts({ source: "scheduler" });

    expect(resolvePageToken).not.toHaveBeenCalled();
    expect(publishPageVideo).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "pg1", accessToken: "tok" })
    );
  });

  it("fails when no Page is connected", async () => {
    useDb({
      claim: [
        claimedRow({
          kind: "video",
          image_url: "https://blob.example/v1.mp4",
        }),
      ],
      // The claim returns the post-claim attempt count: 3 = exhausted, so
      // the row fails instead of requeueing for another try.
      claimRow: [{ id: 1, attempts: 3 }],
    });
    vi.mocked(getPrimaryPage).mockResolvedValue(null);

    await expect(
      publishDuePosts({ source: "scheduler" })
    ).resolves.toEqual({ due: 1, published: 0, failed: 1, synced: 0 });

    expect(downloadVideoFromUrl).not.toHaveBeenCalled();
    expect(events().map((event) => event.event)).toEqual(["claimed", "failed"]);
  });

  it("fails when the staged file is missing", async () => {
    useDb({
      claim: [claimedRow({ kind: "video", image_url: null })],
      claimRow: [{ id: 1, attempts: 3 }],
    });
    vi.mocked(getPrimaryPage).mockResolvedValue({
      pageId: "pg1",
      token: "tok",
    });

    await expect(
      publishDuePosts({ source: "scheduler" })
    ).resolves.toEqual({ due: 1, published: 0, failed: 1, synced: 0 });

    expect(downloadVideoFromUrl).not.toHaveBeenCalled();
    expect(publishPageVideo).not.toHaveBeenCalled();
    expect(deleteStagedBlobs).not.toHaveBeenCalled();
  });
});
