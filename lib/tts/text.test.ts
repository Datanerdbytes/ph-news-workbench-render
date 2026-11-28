import { describe, expect, it } from "vitest";
import { normalizeSpeechText } from "./text";

describe("normalizeSpeechText", () => {
  it("removes Markdown and speaks link labels instead of URLs", () => {
    expect(
      normalizeSpeechText(
        "**Read** [the report](https://example.com/report) and visit https://example.com/news.",
      ),
    ).toBe("Read the report and visit");
  });

  it("collapses whitespace and trims the narration", () => {
    expect(normalizeSpeechText("  First   line.\n  Second   line.  ")).toBe(
      "First line.\nSecond line.",
    );
  });

  it("keeps paragraph breaks for the broadcast pauses", () => {
    expect(normalizeSpeechText("  First line.\n\n  Second   line.  ")).toBe(
      "First line.\n\nSecond line.",
    );
  });
});
