import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("./provider-rate-limit", () => ({
  deferAvatarRequests: vi.fn(),
  waitForAvatarRequest: vi.fn().mockResolvedValue(undefined),
}));

import {
  avatarEndpoint,
  deleteAvatarSynthesis,
  downloadAvatarResult,
  getAvatarSynthesis,
  submitAvatarSynthesis,
} from "./azure";
import {
  deferAvatarRequests,
  waitForAvatarRequest,
} from "./provider-rate-limit";

const ENDPOINT = "https://avatar.test";
const RESULT_URL = "https://account.blob.core.windows.net/output/avatar.mp4";
const INPUT = {
  synthesisId: "job-1",
  text: "Hello",
  avatarId: "meg-formal" as const,
  voiceId: "en-PH-RosaNeural" as const,
  speed: 1,
};

let workDir: string;
let destination: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("AZURE_SPEECH_KEY", "");
  vi.stubEnv("AZURE_SPEECH_REGION", "");
  vi.stubEnv("AZURE_AVATAR_SPEECH_KEY", "  test-key  ");
  vi.stubEnv("AZURE_AVATAR_SPEECH_REGION", "southeastasia");
  vi.stubEnv("AZURE_AVATAR_SPEECH_ENDPOINT", ENDPOINT);
  workDir = await mkdtemp(path.join(os.tmpdir(), "avatar-azure-test-"));
  destination = path.join(workDir, "avatar.mp4");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(workDir, { recursive: true, force: true });
});

function synthesis(status = "Succeeded") {
  return {
    id: "job-1",
    status,
    outputs: { result: RESULT_URL },
    properties: {
      durationInMilliseconds: 12_500,
      billingDetails: { talkingAvatarDurationSeconds: 13.4 },
      error: { code: "ProviderCode" },
    },
  };
}

function providerResponse(status = "Succeeded", httpStatus = 200) {
  return new Response(JSON.stringify(synthesis(status)), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

function mp4() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftyp"),
    Buffer.from("isom0000"),
  ]);
}

describe("avatarEndpoint", () => {
  it("uses the regional origin when no endpoint override is set", () => {
    vi.stubEnv("AZURE_AVATAR_SPEECH_ENDPOINT", "");
    expect(avatarEndpoint()).toBe(
      "https://southeastasia.api.cognitive.microsoft.com",
    );
  });

  it.each([
    ["AZURE_AVATAR_SPEECH_KEY", ""],
    ["AZURE_AVATAR_SPEECH_REGION", ""],
    ["AZURE_AVATAR_SPEECH_REGION", "bad_region"],
  ])("rejects missing or invalid %s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => avatarEndpoint()).toThrowError(
      expect.objectContaining({
        status: 503,
        code: "not_configured",
        retryable: false,
      }),
    );
  });

  it.each([
    "not a url",
    "http://avatar.test",
    "https://user:pass@avatar.test",
    "https://avatar.test/path",
    "https://avatar.test/?query=1",
    "https://avatar.test/#fragment",
  ])("requires an HTTPS origin, not %s", (endpoint) => {
    vi.stubEnv("AZURE_AVATAR_SPEECH_ENDPOINT", endpoint);
    expect(() => avatarEndpoint()).toThrowError(
      expect.objectContaining({ status: 503, code: "not_configured" }),
    );
  });

  it("normalizes a configured HTTPS origin", () => {
    vi.stubEnv("AZURE_AVATAR_SPEECH_ENDPOINT", "https://avatar.test/");
    expect(avatarEndpoint()).toBe(ENDPOINT);
  });
});

describe("submitAvatarSynthesis", () => {
  it.each([
    {
      avatarId: "meg-formal" as const,
      avatarConfig: {
        talkingAvatarCharacter: "meg",
        talkingAvatarStyle: "formal",
        customized: false,
        videoFormat: "mp4",
        videoCodec: "h264",
        subtitleType: "none",
        bitrateKbps: 2000,
      },
    },
    {
      avatarId: "max-business" as const,
      avatarConfig: {
        talkingAvatarCharacter: "max",
        talkingAvatarStyle: "business",
        customized: false,
        videoFormat: "mp4",
        videoCodec: "h264",
        subtitleType: "none",
        bitrateKbps: 2000,
      },
    },
    {
      avatarId: "anika" as const,
      avatarConfig: {
        talkingAvatarCharacter: "anika",
        photoAvatarBaseModel: "vasa-1",
        videoFormat: "mp4",
        videoCodec: "h264",
        subtitleType: "none",
        bitrateKbps: 2000,
      },
    },
  ])("sends a deterministic PUT body for $avatarId", async ({ avatarId, avatarConfig }) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse("NotStarted"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitAvatarSynthesis({ ...INPUT, avatarId });

    expect(result).toEqual({
      id: "job-1",
      status: "NotStarted",
      resultUrl: RESULT_URL,
      durationSeconds: 12.5,
      billedAvatarSeconds: 13.4,
      errorCode: "ProviderCode",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(waitForAvatarRequest).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${ENDPOINT}/avatar/batchsyntheses/job-1?api-version=2024-08-01`,
    );
    expect(init).toMatchObject({
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": "test-key",
        "User-Agent": "PH-News-Workbench/1.0",
        "Operation-Id": "job-1",
      },
      body: JSON.stringify({
        inputKind: "SSML",
        inputs: [
          {
            content:
              '<speak version="1.0" xml:lang="en-PH"><voice name="en-PH-RosaNeural"><prosody rate="+0%">Hello</prosody></voice></speak>',
          },
        ],
        avatarConfig,
        properties: { timeToLiveInHours: 24 },
      }),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the S0 Speech credentials", async () => {
    vi.stubEnv("AZURE_AVATAR_SPEECH_KEY", "");
    vi.stubEnv("AZURE_AVATAR_SPEECH_REGION", "");
    vi.stubEnv("AZURE_AVATAR_SPEECH_ENDPOINT", "");
    vi.stubEnv("AZURE_SPEECH_KEY", "speech-key");
    vi.stubEnv("AZURE_SPEECH_REGION", "southeastasia");
    const fetchMock = vi.fn().mockResolvedValue(providerResponse("NotStarted"));
    vi.stubGlobal("fetch", fetchMock);

    await submitAvatarSynthesis(INPUT);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://southeastasia.api.cognitive.microsoft.com/avatar/batchsyntheses/job-1?api-version=2024-08-01",
    );
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("speech-key");
  });

  it.each([
    [0.75, "-25%"],
    [0.9, "-10%"],
    [1.25, "+25%"],
  ])("uses the selected voice, escaped text, and speed %s", async (speed, rate) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse());
    vi.stubGlobal("fetch", fetchMock);

    await submitAvatarSynthesis({
      ...INPUT,
      text: 'A & <B> "C" \'D\'',
      voiceId: "fil-PH-BlessicaNeural",
      speed,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as {
      inputs: Array<{ content: string }>;
    };
    expect(body.inputs[0].content).toBe(
      `<speak version="1.0" xml:lang="fil-PH"><voice name="fil-PH-BlessicaNeural"><prosody rate="${rate}">A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;</prosody></voice></speak>`,
    );
  });

  it.each([
    [429, 429, "rate_limited", true],
    [401, 503, "not_configured", false],
    [403, 503, "not_configured", false],
    [400, 502, "avatar_rejected", false],
    [500, 502, "provider_error", true],
  ])("maps provider HTTP %s to a safe error", async (httpStatus, status, code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("secret upstream detail", { status: httpStatus }),
      ),
    );

    const error = await submitAvatarSynthesis(INPUT).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status, code, retryable });
    expect((error as Error).message).not.toContain("secret upstream detail");
    if (httpStatus === 429) {
      expect(deferAvatarRequests).toHaveBeenCalledWith(expect.any(Response));
    }
  });

  it("maps network failures and malformed success bodies without leaking details", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret network detail"))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const networkError = await submitAvatarSynthesis(INPUT).catch((caught: unknown) => caught);
    expect(networkError).toMatchObject({ status: 502, code: "provider_error" });
    expect((networkError as Error).message).not.toContain("secret network detail");

    await expect(submitAvatarSynthesis(INPUT)).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
    });
  });
});

describe("getAvatarSynthesis", () => {
  it("fetches the provider job without caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse("Running"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAvatarSynthesis("job-1")).resolves.toMatchObject({
      id: "job-1",
      status: "Running",
    });
    expect(waitForAvatarRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${ENDPOINT}/avatar/batchsyntheses/job-1?api-version=2024-08-01`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns null for a provider 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(getAvatarSynthesis("missing")).resolves.toBeNull();
  });
});

describe("deleteAvatarSynthesis", () => {
  it("tolerates a provider 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteAvatarSynthesis("job-1")).resolves.toBeUndefined();
    expect(waitForAvatarRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("surfaces a safe error for other provider failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret", { status: 403 })),
    );
    await expect(deleteAvatarSynthesis("job-1")).rejects.toMatchObject({
      status: 503,
      code: "not_configured",
      retryable: false,
    });
  });
});

describe("downloadAvatarResult", () => {
  it.each([
    "not a url",
    "http://account.blob.core.windows.net/avatar.mp4",
    "https://user:pass@account.blob.core.windows.net/avatar.mp4",
    "https://evil.test/avatar.mp4",
    "https://blob.core.windows.net.evil.test/avatar.mp4",
    "https://notblob.core.windows.net/avatar.mp4",
  ])("rejects an untrusted result URL before fetching: %s", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadAvatarResult({ url, destination, maxBytes: 1024 }),
    ).rejects.toMatchObject({ status: 502, code: "invalid_result" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows only trusted HTTPS blob redirects and streams a valid MP4", async () => {
    const bytes = mp4();
    const redirected = "https://second.blob.core.windows.net/output/avatar.mp4";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/next.mp4" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: redirected } }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadAvatarResult({ url: RESULT_URL, destination, maxBytes: bytes.length }),
    ).resolves.toBe(bytes.length);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toEqual(
      new URL("https://account.blob.core.windows.net/next.mp4"),
    );
    expect(fetchMock.mock.calls[2][0]).toEqual(new URL(redirected));
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ redirect: "manual", cache: "no-store" });
    }
  });

  it("rejects a redirect to an untrusted host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/avatar.mp4" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadAvatarResult({ url: RESULT_URL, destination, maxBytes: 1024 }),
    ).rejects.toMatchObject({ status: 502, code: "invalid_result" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after four redirects", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "/again.mp4" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadAvatarResult({ url: RESULT_URL, destination, maxBytes: 1024 }),
    ).rejects.toMatchObject({ status: 502, code: "download_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects an oversized declared body before streaming", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(mp4(), {
        status: 200,
        headers: { "content-length": "100" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadAvatarResult({ url: RESULT_URL, destination, maxBytes: 10 }),
    ).rejects.toMatchObject({ status: 502, code: "video_too_large" });
  });

  it("enforces the size limit while streaming an undeclared body", async () => {
    const bytes = mp4();
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadAvatarResult({ url: RESULT_URL, destination, maxBytes: bytes.length - 1 }),
    ).rejects.toMatchObject({ status: 502, code: "video_too_large" });
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["non-MP4", Buffer.from("this is not a video")],
  ])("rejects an %s downloaded file", async (_label, bytes) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })),
    );

    await expect(
      downloadAvatarResult({ url: RESULT_URL, destination, maxBytes: 1024 }),
    ).rejects.toMatchObject({ status: 502, code: "invalid_video" });
  });

  it("maps non-success responses, missing bodies, and network failures safely", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error("secret download detail"));
    vi.stubGlobal("fetch", fetchMock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await downloadAvatarResult({
        url: RESULT_URL,
        destination,
        maxBytes: 1024,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ status: 502, code: "download_failed" });
      expect((error as Error).message).not.toContain("secret download detail");
    }
  });
});
