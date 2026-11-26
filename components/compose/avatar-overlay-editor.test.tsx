// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AVATAR_PLACEMENT,
  avatarPlacementPreset,
} from "@/lib/videos/composition";
import { AvatarOverlayEditor } from "./avatar-overlay-editor";

function props(overrides: Record<string, unknown> = {}) {
  return {
    avatarUrl: "https://storage.example/avatar.mp4",
    baseVideoUrl: null,
    images: ["data:image/jpeg;base64,photo"],
    placement: DEFAULT_AVATAR_PLACEMENT,
    onPlacementChange: vi.fn(),
    originalAudioVolume: 0.25,
    onOriginalAudioVolumeChange: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

afterEach(cleanup);

describe("AvatarOverlayEditor", () => {
  it("shows the attached photo beneath the avatar in a 16:9 editor", () => {
    render(<AvatarOverlayEditor {...props()} />);

    expect(
      screen.getByAltText("Attached photo beneath the avatar").getAttribute("src"),
    ).toBe("data:image/jpeg;base64,photo");
    expect(
      screen.getByRole("button", { name: /Avatar overlay\. Use arrow keys/ }),
    ).toBeTruthy();
    expect(screen.getByText(/Overlay edits do not regenerate/)).toBeTruthy();
  });

  it("applies presets and fine movement without requiring a drag", () => {
    const editorProps = props();
    render(<AvatarOverlayEditor {...editorProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Lower left" }));
    expect(editorProps.onPlacementChange).toHaveBeenLastCalledWith(
      avatarPlacementPreset("lower-left", 16 / 9),
    );
    expect(
      screen.getByRole("button", { name: "Lower left" }).getAttribute("aria-pressed"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Move avatar right" }));
    expect(editorProps.onPlacementChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AVATAR_PLACEMENT,
      x: 0.65,
    });
  });

  it("supports keyboard movement, resizing, and reset", () => {
    const editorProps = props();
    render(<AvatarOverlayEditor {...editorProps} />);
    const overlay = screen.getByRole("button", {
      name: /Avatar overlay\. Use arrow keys/,
    });

    fireEvent.keyDown(overlay, { key: "ArrowRight" });
    expect(editorProps.onPlacementChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AVATAR_PLACEMENT,
      x: 0.64,
    });

    fireEvent.keyDown(overlay, { key: "ArrowUp", shiftKey: true });
    expect(editorProps.onPlacementChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AVATAR_PLACEMENT,
      y: 0.58,
    });

    fireEvent.keyDown(overlay, { key: "+" });
    const resized = editorProps.onPlacementChange.mock.calls.at(-1)?.[0];
    expect(resized?.width).toBeCloseTo(0.36);
    expect(resized?.x).toBe(DEFAULT_AVATAR_PLACEMENT.x);
    expect(resized?.y).toBe(DEFAULT_AVATAR_PLACEMENT.y);

    fireEvent.keyDown(overlay, { key: "Home" });
    expect(editorProps.onPlacementChange).toHaveBeenLastCalledWith(
      avatarPlacementPreset("lower-right", 16 / 9),
    );
  });

  it("moves and resizes from pointer input", () => {
    const editorProps = props();
    render(<AvatarOverlayEditor {...editorProps} />);
    const overlay = screen.getByRole("button", {
      name: /Avatar overlay\. Use arrow keys/,
    });
    const preview = overlay.parentElement?.parentElement;
    if (!preview) throw new Error("Missing preview");
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(overlay, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(preview, {
      pointerId: 1,
      clientX: 200,
      clientY: 150,
    });
    const moved = editorProps.onPlacementChange.mock.calls.at(-1)?.[0];
    expect(moved?.x).toBeCloseTo(0.66);
    expect(moved?.y).toBeCloseTo(0.66);
    expect(moved?.width).toBe(DEFAULT_AVATAR_PLACEMENT.width);
    fireEvent.pointerUp(preview, { pointerId: 1 });

    const resize = screen.getByRole("button", { name: "Resize avatar overlay" });
    fireEvent.pointerDown(resize, {
      button: 0,
      pointerId: 2,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(preview, {
      pointerId: 2,
      clientX: 200,
      clientY: 150,
    });
    const resized = editorProps.onPlacementChange.mock.calls.at(-1)?.[0];
    expect(resized?.x).toBeCloseTo(0.56);
    expect(resized?.y).toBeCloseTo(0.56);
    expect(resized?.width).toBeCloseTo(0.44);
  });

  it("wires size and original-audio controls", () => {
    const editorProps = props({ baseVideoUrl: "blob:attached-video" });
    render(<AvatarOverlayEditor {...editorProps} />);

    fireEvent.change(screen.getByRole("slider", { name: /Avatar size/ }), {
      target: { value: "0.5" },
    });
    expect(editorProps.onPlacementChange).toHaveBeenLastCalledWith({
      x: 0.5,
      y: 0.5,
      width: 0.5,
    });

    fireEvent.change(
      screen.getByRole("slider", { name: /Original video volume/ }),
      { target: { value: "0.4" } },
    );
    expect(editorProps.onOriginalAudioVolumeChange).toHaveBeenCalledWith(0.4);
    expect(
      screen.getByLabelText("Attached video beneath the avatar").getAttribute("src"),
    ).toBe("blob:attached-video");
  });

  it("disables every editing control while the composer is locked", () => {
    render(<AvatarOverlayEditor {...props({ disabled: true })} />);

    for (const button of screen.getAllByRole("button")) {
      if (button.tagName === "BUTTON") {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      } else {
        expect(button.getAttribute("aria-disabled")).toBe("true");
      }
    }
    for (const slider of screen.getAllByRole("slider")) {
      expect((slider as HTMLInputElement).disabled).toBe(true);
    }
  });
});
