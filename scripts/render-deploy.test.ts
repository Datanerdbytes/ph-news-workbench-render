import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  dashboardUrl,
  describeStatus,
  readDeployId,
  runDeploy,
  sameCommit,
  triggerDeploy,
  waitForDeploy,
} from "./render-deploy.mjs";

type QueuedResponse = { status?: number; body?: unknown };

function stubFetch(responses: QueuedResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("the test did not queue a response for this call");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe("classifyStatus", () => {
  it("treats a live deploy as success", () => {
    expect(classifyStatus("live")).toBe("live");
  });

  it("treats every failure status as a failure", () => {
    for (const status of [
      "build_failed",
      "update_failed",
      "pre_deploy_failed",
      "canceled",
      "deactivated",
    ]) {
      expect(classifyStatus(status)).toBe("failed");
    }
  });

  it("treats the in-flight statuses as pending", () => {
    for (const status of [
      "created",
      "queued",
      "pre_deploy_in_progress",
      "build_in_progress",
      "update_in_progress",
    ]) {
      expect(classifyStatus(status)).toBe("pending");
    }
  });

  it("does not guess about a status it does not know", () => {
    expect(classifyStatus("something_new")).toBe("unknown");
    expect(classifyStatus(undefined)).toBe("unknown");
  });
});

describe("describeStatus", () => {
  it("names the reason a deploy did not go live", () => {
    expect(describeStatus("build_failed")).toContain("Docker build failed");
    expect(describeStatus("update_failed")).toContain("starting");
    expect(describeStatus("unknown_status")).toContain("unknown_status");
  });
});

describe("readDeployId", () => {
  it("reads the id out of the API payload", () => {
    expect(readDeployId({ deploy: { id: "dep-1" } })).toBe("dep-1");
  });

  it("returns null when the payload carries no id", () => {
    expect(readDeployId({})).toBeNull();
    expect(readDeployId(null)).toBeNull();
    expect(readDeployId({ deploy: { id: "" } })).toBeNull();
  });
});

describe("sameCommit", () => {
  it("compares a short sha against a full one", () => {
    expect(sameCommit("428ed8187958632859bf58f2bd77cd81c27a16a5", "428ed81")).toBe(true);
    expect(sameCommit("428ed81", "428ed8187958632859bf58f2bd77cd81c27a16a5")).toBe(true);
  });

  it("rejects two different commits", () => {
    expect(sameCommit("428ed81", "c662bc0")).toBe(false);
    expect(sameCommit(undefined, "428ed81")).toBe(false);
  });
});

describe("dashboardUrl", () => {
  it("points at the deploy in the Render dashboard", () => {
    expect(dashboardUrl("srv-1", "dep-1")).toBe(
      "https://dashboard.render.com/web/srv-1/deploys/dep-1",
    );
  });
});

describe("triggerDeploy", () => {
  it("posts the commit and returns the deploy id", async () => {
    const { impl, calls } = stubFetch([{ status: 201, body: { deploy: { id: "dep-9" } } }]);

    const result = await triggerDeploy({
      apiKey: "key",
      serviceId: "srv-1",
      commitId: "abc123",
      fetchImpl: impl,
    });

    expect(result.deployId).toBe("dep-9");
    expect(calls[0].url).toBe("https://api.render.com/v1/services/srv-1/deploys");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ commitId: "abc123" });
  });

  it("fails with the API's own message and keeps the key out of it", async () => {
    const { impl } = stubFetch([{ status: 401, body: { message: "Unauthorized" } }]);

    const error = (await triggerDeploy({
      apiKey: "rnd_secret_key",
      serviceId: "srv-1",
      commitId: "abc123",
      fetchImpl: impl,
    }).catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("401");
    expect(error.message).toContain("Unauthorized");
    expect(error.message).not.toContain("rnd_secret_key");
  });

  it("fails when Render accepts the deploy but returns no id", async () => {
    const { impl } = stubFetch([{ status: 201, body: {} }]);

    await expect(
      triggerDeploy({
        apiKey: "key",
        serviceId: "srv-1",
        commitId: "abc123",
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/did not return a deploy id/);
  });
});

describe("waitForDeploy", () => {
  it("waits through the pending statuses and returns the live deploy", async () => {
    const { impl } = stubFetch([
      { body: { status: "build_in_progress" } },
      { body: { status: "update_in_progress" } },
      { body: { status: "live", commit: { id: "abc123" } } },
    ]);

    const deploy = await waitForDeploy({
      apiKey: "key",
      serviceId: "srv-1",
      deployId: "dep-9",
      timeoutMs: 60_000,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(deploy.status).toBe("live");
  });

  it("throws when the deploy fails", async () => {
    const { impl } = stubFetch([{ body: { status: "build_failed" } }]);

    await expect(
      waitForDeploy({
        apiKey: "key",
        serviceId: "srv-1",
        deployId: "dep-9",
        timeoutMs: 60_000,
        fetchImpl: impl,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/Docker build failed/);
  });

  it("throws when the deploy does not finish in time", async () => {
    const { impl } = stubFetch([
      { body: { status: "build_in_progress" } },
      { body: { status: "build_in_progress" } },
    ]);

    await expect(
      waitForDeploy({
        apiKey: "key",
        serviceId: "srv-1",
        deployId: "dep-9",
        timeoutMs: 0,
        fetchImpl: impl,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/timeout/);
  });
});

describe("runDeploy", () => {
  it("deploys the requested commit and confirms what went live", async () => {
    const { impl } = stubFetch([
      { status: 201, body: { deploy: { id: "dep-9" } } },
      { body: { status: "live", commit: { id: "abc123def456" } } },
    ]);

    const result = await runDeploy({
      apiKey: "key",
      serviceId: "srv-1",
      commitId: "abc123",
      timeoutMs: 60_000,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(result.deployId).toBe("dep-9");
    expect(result.commitId).toBe("abc123def456");
  });

  it("fails when a different commit went live", async () => {
    const { impl } = stubFetch([
      { status: 201, body: { deploy: { id: "dep-9" } } },
      { body: { status: "live", commit: { id: "0000000" } } },
    ]);

    await expect(
      runDeploy({
        apiKey: "key",
        serviceId: "srv-1",
        commitId: "abc123",
        timeoutMs: 60_000,
        fetchImpl: impl,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/instead of abc123/);
  });
});
