import { describe, expect, it } from "vitest";
import {
  MEDIA_REJECTED_BEFORE_GRAPH,
  shouldDeleteAvatarCompositeAfterPublishFailure,
} from "./publish-cleanup";

const base = {
  avatarJobId: "avatar-1",
  mediaUrl: "https://store.example/compose/avatars/avatar-1/final.mp4",
  sourceAvatarUrl: "https://store.example/avatars/avatar-1/source.mp4",
};

describe("shouldDeleteAvatarCompositeAfterPublishFailure", () => {
  it.each([
    { status: 400, code: MEDIA_REJECTED_BEFORE_GRAPH },
    { status: 409, code: "avatar_unavailable" },
  ])("accepts a definite avatar composite rejection: %o", (failure) => {
    expect(
      shouldDeleteAvatarCompositeAfterPublishFailure({ ...base, ...failure }),
    ).toBe(true);
  });

  it.each([
    { status: 400, code: undefined },
    { status: 400, code: "validation_error" },
    { status: 401, code: "unauthorized" },
    { status: 403, code: "permission" },
    { status: 404, code: "not_found" },
    { status: 409, code: "conflict" },
    { status: 500, code: "publish_failed" },
    { status: 502, code: "publish_failed" },
  ])("retains media after an unmarked or ambiguous failure: %o", (failure) => {
    expect(
      shouldDeleteAvatarCompositeAfterPublishFailure({ ...base, ...failure }),
    ).toBe(false);
  });

  it("never deletes a non-avatar bake", () => {
    expect(
      shouldDeleteAvatarCompositeAfterPublishFailure({
        ...base,
        avatarJobId: null,
        status: 400,
        code: MEDIA_REJECTED_BEFORE_GRAPH,
      }),
    ).toBe(false);
  });

  it("never deletes a missing or standalone avatar URL", () => {
    expect(
      shouldDeleteAvatarCompositeAfterPublishFailure({
        ...base,
        mediaUrl: null,
        status: 400,
        code: MEDIA_REJECTED_BEFORE_GRAPH,
      }),
    ).toBe(false);
    expect(
      shouldDeleteAvatarCompositeAfterPublishFailure({
        ...base,
        mediaUrl: base.sourceAvatarUrl,
        status: 400,
        code: MEDIA_REJECTED_BEFORE_GRAPH,
      }),
    ).toBe(false);
  });
});
