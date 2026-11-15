import { describe, expect, it } from "vitest";
import { GATE_HINTS, type GateHintPlatform } from "./gate-hints";

// The account each platform publishes as — the hint has to name it, and to
// name it first. Typed against the hints themselves so a platform without a
// hint (or a hint without an account) fails to compile.
const ACCOUNT_NOUNS: Record<GateHintPlatform, string> = {
  facebook: "Facebook Page",
  instagram: "Instagram business account",
  youtube: "YouTube channel",
  tiktok: "TikTok account",
};

describe("GATE_HINTS", () => {
  it("covers every platform composer", () => {
    expect(Object.keys(GATE_HINTS).sort()).toEqual([
      "facebook",
      "instagram",
      "tiktok",
      "youtube",
    ]);
  });

  it("leads with the account and keeps one shared shape", () => {
    for (const [platform, hint] of Object.entries(GATE_HINTS)) {
      const account = ACCOUNT_NOUNS[platform as GateHintPlatform];
      expect(hint, platform).toContain(account);
      expect(hint, platform).toContain("has to be connected before you can publish");
      expect(hint, platform).toContain(" — ");
      // The account leads: it opens the sentence, not a trailing clause.
      const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(hint, platform).toMatch(new RegExp(`^An? ${escaped}`));
    }
  });
});
