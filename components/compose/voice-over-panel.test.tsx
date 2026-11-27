// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceOverPanel,
  type VoiceOverAudio,
} from "./voice-over-panel";

function props(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    onEnabledChange: vi.fn(),
    voiceId: "en-PH-RosaNeural" as const,
    onVoiceChange: vi.fn(),
    speed: 1,
    onSpeedChange: vi.fn(),
    originalVolume: 0.25,
    onOriginalVolumeChange: vi.fn(),
    showOriginalVolume: false,
    audio: null,
    generating: false,
    error: "",
    stale: false,
    hasMedia: true,
    hasText: true,
    disabled: false,
    onGenerate: vi.fn(),
    onRemove: vi.fn(),
    onDurationChange: vi.fn(),
    ...overrides,
  };
}

const readyAudio: VoiceOverAudio = {
  blob: new Blob(["speech"], { type: "audio/mpeg" }),
  url: "blob:narration",
  text: "A ready draft",
  voiceId: "en-PH-RosaNeural",
  speed: 1,
  duration: 3.2,
};

afterEach(cleanup);

describe("VoiceOverPanel", () => {
  it("keeps narration controls hidden until voice-over is enabled", () => {
    const panelProps = props({ enabled: false });
    render(<VoiceOverPanel {...panelProps} />);

    const toggle = screen.getByRole("switch", { name: /Voice-over/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("Voice")).toBeNull();
    fireEvent.click(toggle);
    expect(panelProps.onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("can omit its toggle when embedded in the narration mode selector", () => {
    render(<VoiceOverPanel {...props({ showToggle: false })} />);

    expect(screen.queryByRole("switch", { name: /Voice-over/ })).toBeNull();
    expect(screen.getByText("Voice-over", { selector: "div" })).toBeTruthy();
  });

  it("requires both draft text and attached media before generation", () => {
    const panelProps = props({ hasMedia: false, hasText: false });
    const { rerender } = render(<VoiceOverPanel {...panelProps} />);

    const generate = screen.getByRole("button", {
      name: "Generate voice-over",
    }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(
      screen.getByText("Add a photo or video to attach the voice-over to a post."),
    ).toBeTruthy();

    rerender(<VoiceOverPanel {...props()} />);
    expect(
      (screen.getByRole("button", {
        name: "Generate voice-over",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("wires voice, speed, and original-volume controls to their callbacks", () => {
    const panelProps = props({ showOriginalVolume: true });
    render(<VoiceOverPanel {...panelProps} />);

    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "fil-PH-AngeloNeural" },
    });
    fireEvent.change(screen.getByRole("slider", { name: /Speaking speed/ }), {
      target: { value: "1.25" },
    });
    fireEvent.change(
      screen.getByRole("slider", { name: /Original video volume/ }),
      { target: { value: "0.5" } },
    );

    expect(panelProps.onVoiceChange).toHaveBeenCalledWith("fil-PH-AngeloNeural");
    expect(panelProps.onSpeedChange).toHaveBeenCalledWith(1.25);
    expect(panelProps.onOriginalVolumeChange).toHaveBeenCalledWith(0.5);
  });

  it("shows the generated preview and lets the user remove it", () => {
    const panelProps = props({ audio: readyAudio });
    render(<VoiceOverPanel {...panelProps} />);

    expect(screen.getByLabelText("Voice-over preview").getAttribute("src")).toBe(
      "blob:narration",
    );
    expect(screen.getByText("3.2 sec")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Voice-over ready.");
    fireEvent.click(screen.getByRole("button", { name: "Remove voice-over" }));
    expect(panelProps.onRemove).toHaveBeenCalledTimes(1);
  });

  it("announces stale narration and provider errors", () => {
    const { rerender } = render(
      <VoiceOverPanel {...props({ audio: readyAudio, stale: true })} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Regenerate the voice-over before publishing.",
    );

    rerender(
      <VoiceOverPanel {...props({ error: "Daily voice-over limit reached." })} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Daily voice-over limit reached.",
    );
  });

  it("disables generation while a request is running", () => {
    render(<VoiceOverPanel {...props({ generating: true })} />);
    const generate = screen.getByRole("button", {
      name: "Generating…",
    }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Generating voice-over",
    );
  });
});
