import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));
vi.mock("@/lib/publishing/connection", () => ({
  resolvePageTargets: vi.fn(),
}));
vi.mock("@/lib/facebook", () => ({
  publishPagePost: vi.fn(),
  parseImages: vi.fn(() => []),
  redactTokens: (value: string) => value,
  FacebookApiError: class FacebookApiError extends Error {},
}));
vi.mock("@/lib/notifications", () => ({
  notifyTokenInvalid: vi.fn(),
  notifyWorkspace: vi.fn(),
}));
vi.mock("@/lib/schedule-mirror", () => ({ recordNativeSchedule: vi.fn() }));

import { sql } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { resolvePageTargets } from "@/lib/publishing/connection";
import { publishPagePost } from "@/lib/facebook";
import { recordNativeSchedule } from "@/lib/schedule-mirror";
import { POST } from "./route";

const sqlMock = sql as unknown as Mock;
const sessionMock = requireWorkspace as unknown as Mock;
const targetsMock = resolvePageTargets as unknown as Mock;
const publishMock = publishPagePost as unknown as Mock;
const mirrorMock = recordNativeSchedule as unknown as Mock;

const access = {
  user: { id: "u1" },
  workspace: { id: "ws_1", role: "owner" },
};

const targets = [
  { id: "page_1", name: "The Daily Buzz", accessToken: "page-token" },
];

const permalink = "https://www.facebook.com/dailybuzz/posts/post_1";

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(access);
  targetsMock.mockResolvedValue(targets);
  publishMock.mockResolvedValue({ id: "post_1", permalink });
  mirrorMock.mockResolvedValue(undefined);
  // 1) the connection scopes, 2) the draft the publish flips.
  sqlMock
    .mockResolvedValueOnce([{ scopes: "pages_manage_posts" }])
    .mockResolvedValueOnce([{ id: 42 }]);
});

describe("POST /api/publish", () => {
  it("mirrors the publish so the platform counters see it", async () => {
    const response = await POST(
      post({ newsItemId: 7, message: "Behind the headline", pageId: "page_1" })
    );

    expect(response.status).toBe(200);
    // The publish reached the Page...
    expect(publishMock).toHaveBeenCalledWith({
      pageId: "page_1",
      accessToken: "page-token",
      message: "Behind the headline",
      images: [],
    });
    // ...and left a row behind, linked to the draft it published so the
    // activity log keeps one entry for it.
    expect(mirrorMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "u1",
      kind: "post",
      text: "Behind the headline",
      scheduledFor: null,
      results: [
        {
          page: { id: "page_1", name: "The Daily Buzz" },
          ok: true,
          id: "post_1",
          permalink,
        },
      ],
      newsItemId: 7,
      draftId: 42,
    });
  });

  it("records the publish without a draft when none was flipped", async () => {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ scopes: "pages_manage_posts" }])
      .mockResolvedValueOnce([]);

    const response = await POST(
      post({ newsItemId: 7, message: "Behind the headline" })
    );

    expect(response.status).toBe(200);
    expect(mirrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "post", newsItemId: 7, draftId: null })
    );
  });

  it("mirrors nothing when the publish fails", async () => {
    publishMock.mockRejectedValue(new Error("Facebook said no"));

    const response = await POST(
      post({ newsItemId: 7, message: "Behind the headline" })
    );

    expect(response.status).toBe(500);
    expect(mirrorMock).not.toHaveBeenCalled();
  });
});
