// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicAvatarJob } from "@/lib/avatar/jobs";
import { TalkingAvatarPanel } from "./talking-avatar-panel";

const { previewState } = vi.hoisted(() => ({
  previewState: {
    url: "blob:validated-avatar" as string | null,
    error: null as string | null,
    loading: false,
  },
}));

vi.mock("@/lib/videos/use-avatar-preview", () => ({
  useAvatarPreview: () => previewState,
}));

function props(overrides: Record<string, unknown> = {}) {
  return {
    avatarId: "meg-formal" as const,
    onAvatarChange: vi.fn(),
    voiceId: "en-PH-RosaNeural" as const,
    onVoiceChange: vi.fn(),
    speed: 1,
    onSpeedChange: vi.fn(),
    job: null,
    busy: false,
    error: "",
    stale: false,
    hasText: true,
    hasMedia: false,
    disabled: false,
    onGenerate: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

const readyJob: PublicAvatarJob = {
  id: "avatar-1",
  avatarId: "meg-formal",
  voiceId: "en-PH-RosaNeural",
  speed: 1,
  text: "A ready draft",
  status: "completed",
  statusMessage: "",
  progress: 1,
  videoUrl: "https://storage.example/avatar.mp4",
  durationSeconds: 12.4,
  error: null,
  publishState: "ready",
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:01:00.000Z",
};

beforeEach(() => {
  previewState.url = "blob:validated-avatar";
  previewState.error = null;
  previewState.loading = false;
});

afterEach(cleanup);

describe("TalkingAvatarPanel", () => {
  it("explains paid billing and does not require attached media", () => {
    render(<TalkingAvatarPanel {...props()} />);

    expect(screen.getByText(/Paid Azure service/)).toBeTruthy();
    expect(screen.getByText(/not permanently free/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Generate avatar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("wires avatar, voice, and speed controls to their callbacks", () => {
    const panelProps = props();
    render(<TalkingAvatarPanel {...panelProps} />);

    fireEvent.change(screen.getByLabelText("Avatar"), {
      target: { value: "anika" },
    });
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "fil-PH-AngeloNeural" },
    });
    fireEvent.change(screen.getByRole("slider", { name: /Speaking speed/ }), {
      target: { value: "1.2" },
    });

    expect(panelProps.onAvatarChange).toHaveBeenCalledWith("anika");
    expect(panelProps.onVoiceChange).toHaveBeenCalledWith("fil-PH-AngeloNeural");
    expect(panelProps.onSpeedChange).toHaveBeenCalledWith(1.2);
  });

  it("shows progress and allows an active job to be canceled", () => {
    const panelProps = props({
      job: {
        ...readyJob,
        status: "running",
        progress: 0.42,
        videoUrl: null,
        statusMessage: "Azure is generating the video.",
      },
    });
    render(<TalkingAvatarPanel {...panelProps} />);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("status").textContent).toContain(
      "Azure is generating the video.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    expect(panelProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("previews a ready video and lets the user regenerate or remove it", () => {
    const panelProps = props({ job: readyJob });
    render(<TalkingAvatarPanel {...panelProps} />);

    expect(screen.getByLabelText("Talking avatar preview").getAttribute("src")).toBe(
      "blob:validated-avatar",
    );
    expect(screen.getByText("12.4 sec")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Avatar video ready.");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate avatar" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove avatar video" }));
    expect(panelProps.onGenerate).toHaveBeenCalledTimes(1);
    expect(panelProps.onRemove).toHaveBeenCalledTimes(1);
  });

  it("surfaces preview validation failures without rendering the remote URL", () => {
    previewState.url = null;
    previewState.error = "The avatar video source is not supported.";
    render(<TalkingAvatarPanel {...props({ job: readyJob })} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "The avatar video source is not supported.",
    );
    expect(screen.queryByLabelText("Talking avatar preview")).toBeNull();
  });

  it("blocks stale output and explains scheduled ownership", () => {
    const { rerender } = render(
      <TalkingAvatarPanel {...props({ job: readyJob, stale: true })} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Regenerate before publishing.",
    );

    rerender(
      <TalkingAvatarPanel
        {...props({ job: { ...readyJob, publishState: "scheduled" } })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("scheduled post");
    expect(
      (screen.getByRole("button", { name: "Regenerate avatar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove avatar video" })).toBeNull();
  });

  it("disables generation without draft text and surfaces provider errors", () => {
    const { rerender } = render(
      <TalkingAvatarPanel {...props({ hasText: false })} />,
    );
    expect(
      (screen.getByRole("button", { name: "Generate avatar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    rerender(
      <TalkingAvatarPanel {...props({ error: "Daily avatar limit reached." })} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Daily avatar limit reached.",
    );
  });
});
