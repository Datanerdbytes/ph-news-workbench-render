// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPreset } from "./presets.preview";
import { REEL_PRESETS } from "./presets";

const mounted: { stage: HTMLDivElement; timeline: NonNullable<ReturnType<typeof mountPreset>> }[] = [];

function mount(presetId: string, values: Record<string, string> = {}) {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  const timeline = mountPreset(stage, presetId, values);
  if (timeline) mounted.push({ stage, timeline });
  return { stage, timeline };
}

afterEach(() => {
  for (const { stage, timeline } of mounted.splice(0)) {
    timeline.kill();
    stage.remove();
  }
  document.body.replaceChildren();
});

describe("mountPreset", () => {
  it("returns null for 'none' and for unknown presets", () => {
    expect(mount("none").timeline).toBeNull();
    expect(mount("ghost").timeline).toBeNull();
  });

  it("mounts a looping timeline and DOM for every real preset", () => {
    for (const preset of REEL_PRESETS) {
      if (preset.id === "none") continue;
      const { stage, timeline } = mount(preset.id);
      expect(timeline, preset.id).not.toBeNull();
      expect(stage.childElementCount, preset.id).toBeGreaterThan(0);
    }
  });

  it("renders the user's text for headline and end card", () => {
    const headline = mount("headline", { text: "City hall responds" });
    // Headline words are separate masked spans, so they concatenate.
    for (const word of ["CITY", "HALL", "RESPONDS"]) {
      expect(headline.stage.textContent).toContain(word);
    }

    const endcard = mount("endcard", { text: "Follow for updates" });
    expect(endcard.stage.textContent).toContain("Follow for updates".toUpperCase());
  });

  it("builds the logo sting ring as an SVG stroke that can be swept", () => {
    const { stage } = mount("logosting", { text: "AB" });
    const circle = stage.querySelector("circle");
    expect(circle).not.toBeNull();
    expect(circle!.getAttribute("stroke-dasharray")).not.toBeNull();
    expect(stage.textContent).toContain("AB");
  });

  it("builds a looping timeline that kill() tears down", () => {
    const { timeline } = mount("headline", { text: "Big news" });
    expect(timeline!.totalDuration()).toBeGreaterThan(0);
    expect(timeline!.repeat()).toBe(-1);
    timeline!.kill();
    expect(timeline!.isActive()).toBe(false);
  });

  it("returns null when the viewer prefers reduced motion", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    try {
      const { stage, timeline } = mount("quote");
      expect(timeline).toBeNull();
      // Nothing animates, but the static card still previews.
      expect(stage.childElementCount).toBeGreaterThan(0);
    } finally {
      window.matchMedia = original;
    }
  });
});
