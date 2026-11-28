// @vitest-environment jsdom
import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceOverPanel,
  type VoiceOverAudio,
} from "./voice-over-panel";

function props(
  overrides: Partial<ComponentProps<typeof VoiceOverPanel>> = {},
): ComponentProps<typeof VoiceOverPanel> {
  return {
    enabled: true,
    onEnabledChange: vi.fn(),
    showToggle: true,
    provider: "azure",
    providerConfigured: true,
    providerLoading: false,
    providerRefreshing: false,
    providerLoadError: "",
    clonedVoiceIds: [],
    language: "en",
    voiceId: "en-PH-RosaNeural",
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
  provider: "azure",
  language: "en",
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

  it("lists Azure voices and wires narration controls", () => {
    const panelProps = props({ showOriginalVolume: true });
    render(<VoiceOverPanel {...panelProps} />);

    expect(
      screen.getByRole("option", { name: "English (US) · Ava (Female)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "English (US) · Christopher (Male)" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "en-US-ChristopherNeural" },
    });
    fireEvent.change(screen.getByRole("slider", { name: /Speaking speed/ }), {
      target: { value: "1.25" },
    });
    fireEvent.change(
      screen.getByRole("slider", { name: /Original video volume/ }),
      { target: { value: "0.5" } },
    );

    expect(panelProps.onVoiceChange).toHaveBeenCalledWith(
      "en-US-ChristopherNeural",
    );
    expect(panelProps.onSpeedChange).toHaveBeenCalledWith(1.25);
    expect(panelProps.onOriginalVolumeChange).toHaveBeenCalledWith(0.5);
  });

  it("renders AssemblyAI voices with a fixed natural speaking speed", () => {
    const panelProps = props({
      provider: "assemblyai",
      voiceId: "aai-kyla",
      speed: 1.25,
    });
    render(<VoiceOverPanel {...panelProps} />);

    const voice = screen.getByLabelText("Voice");
    expect(within(voice).getAllByRole("option")).toHaveLength(4);
    expect(
      screen.getByRole("option", { name: "English (US) · Kyla (Female)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "English (US) · Titus (Male)" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /English \(PH\) · Rosa/ }),
    ).toBeNull();
    expect(screen.getByText("Natural (1.00×)")).toBeTruthy();
    expect(
      screen.getByText("AssemblyAI uses a fixed natural speaking speed."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("slider", { name: /Speaking speed/ }),
    ).toBeNull();

    fireEvent.change(voice, { target: { value: "aai-peter" } });
    expect(panelProps.onVoiceChange).toHaveBeenCalledWith("aai-peter");
    expect(panelProps.onSpeedChange).not.toHaveBeenCalled();
  });

  it("lists configured AssemblyAI cloned voices by ID", () => {
    const panelProps = props({
      provider: "assemblyai",
      voiceId: "cloned-voice-id",
      clonedVoiceIds: ["cloned-voice-id"],
    });
    render(<VoiceOverPanel {...panelProps} />);

    expect(
      screen.getByRole("option", { name: "Cloned · cloned-voice-id" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "cloned-voice-id" },
    });
    expect(panelProps.onVoiceChange).toHaveBeenCalledWith("cloned-voice-id");
  });

  it("shows the provider as read-only and links to its Settings section", () => {
    render(
      <VoiceOverPanel
        {...props({ provider: "assemblyai", voiceId: "aai-kyla" })}
      />,
    );

    expect(screen.getByText("Provider:").parentElement).toHaveTextContent(
      "Provider: AssemblyAI",
    );
    expect(
      screen.queryByRole("combobox", { name: /provider/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("radiogroup", { name: /provider/i }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Change in Settings" }),
    ).toHaveAttribute("href", "/settings#text-to-speech");
  });

  it("blocks AssemblyAI for Filipino/Tagalog and explains how to enable it", () => {
    const panelProps = props({
      provider: "assemblyai",
      voiceId: "aai-kyla",
      language: "tl",
    });
    const { rerender } = render(<VoiceOverPanel {...panelProps} />);

    const generate = screen.getByRole("button", {
      name: "Generate voice-over",
    }) as HTMLButtonElement;
    expect(generate).toBeDisabled();
    expect(screen.getByLabelText("Voice")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "AssemblyAI supports English voice-over only. Switch the draft to English or choose Azure Speech in Settings for Filipino or Tagalog.",
    );
    fireEvent.click(generate);
    expect(panelProps.onGenerate).not.toHaveBeenCalled();

    rerender(
      <VoiceOverPanel
        {...props({
          language: "tl",
          voiceId: "fil-PH-BlessicaNeural",
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Generate voice-over" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("option", { name: "Filipino · Blessica (Female)" }),
    ).toBeTruthy();
  });

  it.each([
    {
      name: "unconfigured",
      overrides: { providerConfigured: false },
      message:
        "AssemblyAI is not configured. Update the voice-over provider or credentials in Settings.",
    },
    {
      name: "loading",
      overrides: { providerConfigured: false, providerLoading: true },
      message: "Loading the saved voice-over provider…",
    },
    {
      name: "failed to load",
      overrides: {
        providerConfigured: false,
        providerLoadError: "Could not load the saved voice-over provider.",
      },
      message: "Could not load the saved voice-over provider.",
    },
  ])("disables generation when the provider is $name", ({ overrides, message }) => {
    const panelProps = props({
      provider: "assemblyai",
      voiceId: "aai-kyla",
      ...overrides,
    });
    render(<VoiceOverPanel {...panelProps} />);

    const generate = screen.getByRole("button", {
      name: "Generate voice-over",
    }) as HTMLButtonElement;
    expect(generate).toBeDisabled();
    expect(screen.getByLabelText("Voice")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(message);
    fireEvent.click(generate);
    expect(panelProps.onGenerate).not.toHaveBeenCalled();
  });

  it("blocks regeneration during a settings refresh without hiding ready audio", () => {
    const panelProps = props({
      audio: readyAudio,
      providerRefreshing: true,
    });
    const { rerender } = render(<VoiceOverPanel {...panelProps} />);

    const regenerate = screen.getByRole("button", {
      name: "Regenerate voice-over",
    }) as HTMLButtonElement;
    expect(regenerate).toBeDisabled();
    expect(screen.getByLabelText("Voice")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Voice-over ready.");
    fireEvent.click(regenerate);
    expect(panelProps.onGenerate).not.toHaveBeenCalled();

    rerender(<VoiceOverPanel {...props({ providerRefreshing: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Refreshing the saved voice-over provider",
    );
    expect(
      screen.getByRole("button", { name: "Generate voice-over" }),
    ).toBeDisabled();
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

describe("VoiceOverPanel waveform overlay", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  class FakeDecodeAudioContext {
    decodeAudioData() {
      return Promise.resolve({
        duration: 3.2,
        getChannelData: () =>
          Float32Array.from([
            0.1, 0.9, 0.2, 0.7, 0.3, 1, 0.15, 0.6, 0.25, 0.8, 0.35, 0.5, 0.2,
            0.95, 0.1, 0.65,
          ]),
      });
    }
    close() {
      return Promise.resolve();
    }
  }

  it("offers the photo waveform toggle and live preview when photos are attached", async () => {
    vi.stubGlobal("AudioContext", FakeDecodeAudioContext);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false }),
    );
    const panelProps = props({
      audio: readyAudio,
      hasPhotos: true,
      showWaveform: true,
    });
    render(<VoiceOverPanel {...panelProps} />);

    const toggle = screen.getByRole("switch", {
      name: /Show waveform on photos/,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const preview = await screen.findByRole("img", {
      name: /Preview of the waveform/,
    });
    expect(
      preview.querySelectorAll("[data-bar]").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Bakes an animated waveform over the photos/)).toBeTruthy();
  });

  it("keeps the waveform toggle hidden without photos", () => {
    render(
      <VoiceOverPanel
        {...props({ audio: readyAudio, hasPhotos: false, showWaveform: true })}
      />,
    );

    expect(
      screen.queryByRole("switch", { name: /Show waveform on photos/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: /Preview of the waveform/ }),
    ).toBeNull();
  });

  it("hides the waveform preview when the toggle is off", () => {
    vi.stubGlobal("AudioContext", FakeDecodeAudioContext);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false }),
    );
    const panelProps = props({
      audio: readyAudio,
      hasPhotos: true,
      showWaveform: false,
      onShowWaveformChange: vi.fn(),
    });
    render(<VoiceOverPanel {...panelProps} />);

    const toggle = screen.getByRole("switch", {
      name: /Show waveform on photos/,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByText("The photos bake without the waveform indicator."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: /Preview of the waveform/ }),
    ).toBeNull();
    fireEvent.click(toggle);
    expect(panelProps.onShowWaveformChange).toHaveBeenCalledWith(true);
  });
});
