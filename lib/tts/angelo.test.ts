import { describe, expect, it } from "vitest";
import {
  ANGELO_NEWS_LOCALE,
  ANGELO_NEWS_VOICE_ID,
  buildAngeloNewsSSML,
} from "./angelo";

describe("buildAngeloNewsSSML", () => {
  it("wraps the script in the Angelo news-anchor SSML structure", () => {
    const ssml = buildAngeloNewsSSML("Magandang gabi.");
    expect(ssml).toContain('xmlns="http://www.w3.org/2001/10/synthesis"');
    expect(ssml).toContain(`xml:lang="${ANGELO_NEWS_LOCALE}"`);
    expect(ssml).toContain(`<voice name="${ANGELO_NEWS_VOICE_ID}">`);
    expect(ssml).toContain('rate="+8%" pitch="-3%" volume="+10%"');
    expect(ssml).toContain("Magandang gabi.");
  });

  it("escapes XML special characters in the script", () => {
    const ssml = buildAngeloNewsSSML('A & <B> "C" \'D\'');
    expect(ssml).toContain("A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;");
    expect(ssml).not.toContain("<B>");
  });

  it("spells out Philippine news acronyms whole-word", () => {
    const ssml = buildAngeloNewsSSML(
      "Ang MMDA at PNP, kasama ang DOH, DPWH at NDRRMC, nagpunta sa EDSA.",
    );
    expect(ssml).toContain("M-M-D-A");
    expect(ssml).toContain("P-N-P");
    expect(ssml).toContain("D-O-H");
    expect(ssml).toContain("D-P-W-H");
    expect(ssml).toContain("N-D-R-R-M-C");
    expect(ssml).toContain("Edsa");
    expect(ssml).not.toContain("MMDA");
  });

  it("matches acronyms case-insensitively but not inside words", () => {
    const ssml = buildAngeloNewsSSML("mmda MMDAs");
    expect(ssml).toContain("M-M-D-A");
    expect(ssml).toContain("MMDAs");
  });

  it("injects pauses for double line breaks and colons", () => {
    const ssml = buildAngeloNewsSSML("Ulat ni Ana:\n\nIkalawang bahagi.");
    expect(ssml).toContain('Ulat ni Ana: <break time="250ms"/>');
    expect(ssml).toContain('<break time="450ms"/>');
  });

  it("does not pause inside times such as 10:30", () => {
    const ssml = buildAngeloNewsSSML("Ulat sa 10:30 ngayong gabi.");
    expect(ssml).toContain("10:30");
    expect(ssml).not.toContain("10: <break");
  });

  it("folds the user speed into the rate around the +8% anchor", () => {
    expect(buildAngeloNewsSSML("Ok.")).toContain('rate="+8%"');
    expect(buildAngeloNewsSSML("Ok.", { speed: 1.1 })).toContain('rate="+19%"');
    expect(buildAngeloNewsSSML("Ok.", { speed: 0.75 })).toContain('rate="-19%"');
  });

  it("merges custom pronunciations over the defaults", () => {
    const ssml = buildAngeloNewsSSML("Nasa MMDA at UP Diliman.", {
      replacements: { up: "U-P" },
    });
    expect(ssml).toContain("M-M-D-A");
    expect(ssml).toContain("U-P Diliman");
  });
});
