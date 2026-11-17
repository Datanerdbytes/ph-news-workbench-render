// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";

vi.mock("@/lib/videos/presets.preview", () => ({
  mountVideoPreset: vi.fn(() => null),
}));
vi.mock("@/components/publishing/publish-page", () => ({
  FieldLabel: ({
    htmlFor,
    children,
  }: {
    htmlFor?: string;
    children?: ReactNode;
  }) => <label htmlFor={htmlFor}>{children}</label>,
  inputClass: "",
}));

import {
  VideoAnimationPicker,
  type VideoSlotLoops,
  type VideoSlotSelection,
} from "./video-animation-picker";
import type { PresetSlot, PresetValues } from "@/lib/videos/presets";

/** Stateful harness mirroring how the compose/videos pages wire the picker. */
function Harness({
  onFieldChange = vi.fn(),
}: {
  onFieldChange?: (slot: PresetSlot, key: string, text: string) => void;
}) {
  const [slots, setSlots] = useState<VideoSlotSelection>({
    start: null,
    middle: null,
    end: null,
  });
  const [loops, setLoops] = useState<VideoSlotLoops>({
    start: false,
    middle: false,
    end: false,
  });
  const [values, setValues] = useState<Record<string, PresetValues>>({});
  return (
    <VideoAnimationPicker
      slots={slots}
      loops={loops}
      values={values}
      onSelect={(slot, id) => setSlots((current) => ({ ...current, [slot]: id }))}
      onLoopChange={(slot, loop) => setLoops((current) => ({ ...current, [slot]: loop }))}
      onFieldChange={(slot, key, text) => {
        setValues((current) => ({
          ...current,
          [slot]: { ...current[slot], [key]: text },
        }));
        onFieldChange(slot, key, text);
      }}
    />
  );
}

function slotTab(name: "Open" | "Middle" | "Close"): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function presetCard(name: string): HTMLButtonElement {
  // Remove buttons carry aria-labels; preset cards don't. Filter them out so
  // /End Plate/ doesn't match "Remove End Plate from the end slot".
  const card = screen
    .getAllByRole("button", { name: new RegExp(name) })
    .find((el) => el.getAttribute("aria-label") === null);
  if (!card) throw new Error(`No preset card matching ${name}`);
  return card as HTMLButtonElement;
}

afterEach(cleanup);

describe("VideoAnimationPicker", () => {
  it("opens on the Open slot and only offers open-compatible presets", () => {
    render(<Harness />);
    expect(slotTab("Open").getAttribute("aria-pressed")).toBe("true");
    expect(presetCard("Cinematic Title")).toBeTruthy();
    expect(presetCard("News Ticker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /End Plate/ })).toBeNull();
  });

  it("switches the gallery to the chosen slot's compatible presets", () => {
    render(<Harness />);
    fireEvent.click(slotTab("Close"));
    expect(presetCard("End Plate")).toBeTruthy();
    expect(presetCard("Brand Sting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cinematic Title/ })).toBeNull();
  });

  it("attaches a preset to the active slot and shows its editor", () => {
    render(<Harness />);
    fireEvent.click(presetCard("Cinematic Title"));
    expect(presetCard("Cinematic Title").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Title")).toBeTruthy();
    // Tapping the same card again detaches it.
    fireEvent.click(presetCard("Cinematic Title"));
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("clears the active slot from the None card", () => {
    render(<Harness />);
    fireEvent.click(slotTab("Close"));
    fireEvent.click(presetCard("End Plate"));
    expect(screen.getByLabelText("End plate text")).toBeTruthy();
    fireEvent.click(presetCard("None"));
    expect(screen.queryByLabelText("End plate text")).toBeNull();
  });

  it("toggles looping for the open slot", () => {
    render(<Harness />);
    fireEvent.click(presetCard("Cinematic Title"));
    const loop = screen.getByRole("checkbox") as HTMLInputElement;
    expect(loop.checked).toBe(false);
    fireEvent.click(loop);
    expect(loop.checked).toBe(true);
    expect(
      screen.getByText(/Repeats every 4\.2s — each pass follows the one before/)
    ).toBeTruthy();
  });

  it("describes a streamed loop as scrolling rather than repeating", () => {
    render(<Harness />);
    fireEvent.click(presetCard("News Ticker"));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      screen.getByText(
        "Keeps scrolling through the video, stopping when the closing animation starts."
      )
    ).toBeTruthy();
  });

  it("offers no loop toggle in the close slot — the close effect ends the video", () => {
    render(<Harness />);
    fireEvent.click(slotTab("Close"));
    fireEvent.click(presetCard("End Plate"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Plays last 4s.")).toBeTruthy();
  });

  it("flags cards that are attached to another slot", () => {
    render(<Harness />);
    fireEvent.click(presetCard("Brand Sting"));
    fireEvent.click(slotTab("Close"));
    expect(presetCard("Brand Sting").textContent).toContain("start");
  });

  it("edits field values through onFieldChange, keyed by slot", () => {
    const onFieldChange = vi.fn();
    render(<Harness onFieldChange={onFieldChange} />);
    fireEvent.click(presetCard("Cinematic Title"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Flood aid arrives" },
    });
    expect(onFieldChange).toHaveBeenCalledWith(
      "start",
      "title",
      "Flood aid arrives"
    );
  });

  it("keeps per-slot text independent when one preset fills two slots", () => {
    render(<Harness />);
    fireEvent.click(presetCard("Cinematic Title"));
    fireEvent.click(slotTab("Middle"));
    fireEvent.click(presetCard("Cinematic Title"));
    const startTitle = document.querySelector(
      "#video-preset-start-cinema-title-title"
    ) as HTMLInputElement;
    const middleTitle = document.querySelector(
      "#video-preset-middle-cinema-title-title"
    ) as HTMLInputElement;
    fireEvent.change(middleTitle, { target: { value: "Midpoint line" } });
    expect(startTitle.value).toBe("The story behind the headline");
    expect(middleTitle.value).toBe("Midpoint line");
  });

  it("filters the gallery by category", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Branding" }));
    expect(presetCard("Brand Sting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cinematic Title/ })).toBeNull();
  });

  it("removes an attachment from its editor's remove button", () => {
    render(<Harness />);
    fireEvent.click(presetCard("Cinematic Title"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Cinematic Title from the start slot",
      })
    );
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.getByText("Pick an animation that opens the video.")).toBeTruthy();
  });

  it("disables every control while a bake is running", () => {
    render(
      <VideoAnimationPicker
        slots={{ start: "cinema-title", middle: null, end: null }}
        loops={{ start: false, middle: false, end: false }}
        values={{}}
        disabled
        onSelect={vi.fn()}
        onLoopChange={vi.fn()}
        onFieldChange={vi.fn()}
      />
    );
    expect(slotTab("Open").disabled).toBe(true);
    expect((screen.getByLabelText("Title") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});
