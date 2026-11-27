import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUserMock, publicOriginMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(),
  publicOriginMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireUser: requireUserMock,
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));
vi.mock("@/lib/storage", () => ({
  getManagedStoragePublicOrigin: publicOriginMock,
  getStorageDriver: vi.fn(),
  presignStagedUpload: vi.fn(),
  stageFileToRepo: vi.fn(),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "user-1" });
});

describe("GET /api/stage", () => {
  it("requires an authenticated user", async () => {
    requireUserMock.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/stage", { method: "GET" }),
    );

    expect(response.status).toBe(401);
    expect(publicOriginMock).not.toHaveBeenCalled();
  });

  it("returns only the managed public origin without caching", async () => {
    publicOriginMock.mockReturnValue("https://media.example.com");

    const response = await GET(
      new Request("http://localhost/api/stage", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      publicOrigin: "https://media.example.com",
    });
  });

  it("returns null when the active driver has no managed s3 origin", async () => {
    publicOriginMock.mockReturnValue(null);

    const response = await GET(
      new Request("http://localhost/api/stage", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publicOrigin: null });
  });

  it("fails closed when storage is misconfigured", async () => {
    publicOriginMock.mockImplementation(() => {
      throw new Error("invalid storage driver");
    });

    const response = await GET(
      new Request("http://localhost/api/stage", { method: "GET" }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Storage is misconfigured." });
  });
});
