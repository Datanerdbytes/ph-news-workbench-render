// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicAvatarJob } from "@/lib/avatar/jobs";
import { TalkingAvatarPanel } from "./talking-avatar-panel";

const { previewState, previewMock } = vi.hoisted(() => ({
  previewState: {
    url: "blob:validated-avatar" as string | null,
    error: null as string | null,
    loading: false,
  },
  previewMock: vi.fn(),
}));

vi.mock("@/lib/videos/use-avatar-preview", () => ({
  useAvatarPreview: previewMock,
}));

function props(overrides: Record<string, unknown> = {}) {
  return {
    avatarId: "meg-formal" as const,
    onAvatarChange: vi.fn(),
    voiceId: "en-PH-RosaNeural" as const,
    onVoiceChange: vi.fn(),
    speed: 1,
    onSpeedChange: vi.fn(),
    transparent: false,
    onTransparentChange: vi.fn(),
    transparencySupported: true,
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
  outputFormat: "mp4",
  hasAlpha: false,
  durationSeconds: 12.4,
  error: null,
  publishState: "ready",
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:01:00.000Z",
};

beforeEach(() => {
  previewMock.mockReset().mockReturnValue(previewState);
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

  it("separates full-body and photo avatars and shows only the active selection", () => {
    const { rerender } = render(<TalkingAvatarPanel {...props()} />);

    const fullBodySelect = screen.getByLabelText("Full-body avatar") as HTMLSelectElement;
    const photoSelect = screen.getByLabelText("Photo avatar") as HTMLSelectElement;
    const fullBodyOptions = Array.from(
      fullBodySelect.querySelectorAll('option[value]:not([value=""])'),
    ) as HTMLOptionElement[];
    const photoOptions = Array.from(
      photoSelect.querySelectorAll('option[value]:not([value=""])'),
    ) as HTMLOptionElement[];

    expect(fullBodySelect.value).toBe("meg-formal");
    expect(photoSelect.value).toBe("");
    expect(fullBodyOptions).toHaveLength(21);
    expect(photoOptions).toHaveLength(34);
    expect(fullBodyOptions.every((option) => !option.disabled)).toBe(true);
    expect(
      (within(photoSelect).getByRole("option", { name: "Adrian" }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(photoSelect).getByRole("option", { name: "Leonie · preview (real-time only)" }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    expect(photoSelect.querySelectorAll("option:disabled")).toHaveLength(5);
    expect(
      within(fullBodySelect).getByRole("option", { name: "Rowan" }),
    ).toBeTruthy();
    expect(
      within(fullBodySelect).getByRole("option", {
        name: "Lisa · business-sitting · preview",
      }),
    ).toBeTruthy();
    expect(fullBodySelect.textContent).not.toContain("null");
    expect(photoSelect.textContent).not.toContain("null");
    expect(screen.getByText(/Preview full-body avatars can be generated/)).toBeTruthy();

    rerender(<TalkingAvatarPanel {...props({ avatarId: "anika" })} />);
    expect(fullBodySelect.value).toBe("");
    expect(photoSelect.value).toBe("anika");
  });

  it("wires avatar, voice, and speed controls to their callbacks", () => {
    const panelProps = props();
    render(<TalkingAvatarPanel {...panelProps} />);

    expect(
      screen.getByRole("option", { name: "English (US) · Ava (Female)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "English (US) · Christopher (Male)" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Photo avatar"), {
      target: { value: "anika" },
    });
    fireEvent.change(screen.getByLabelText("Voice"), {
      target: { value: "en-US-ChristopherNeural" },
    });
    fireEvent.change(screen.getByRole("slider", { name: /Speaking speed/ }), {
      target: { value: "1.2" },
    });

    expect(panelProps.onAvatarChange).toHaveBeenCalledWith("anika");
    expect(panelProps.onVoiceChange).toHaveBeenCalledWith(
      "en-US-ChristopherNeural",
    );
    expect(panelProps.onSpeedChange).toHaveBeenCalledWith(1.2);
  });

  it("offers native transparency for Meg and Max only", () => {
    const panelProps = props();
    const { rerender } = render(<TalkingAvatarPanel {...panelProps} />);

    fireEvent.click(screen.getByLabelText("Transparent background"));
    expect(panelProps.onTransparentChange).toHaveBeenCalledWith(true);

    rerender(<TalkingAvatarPanel {...props({ avatarId: "max-casual" })} />);
    expect(screen.getByLabelText("Transparent background")).toBeTruthy();

    rerender(<TalkingAvatarPanel {...props({ avatarId: "rowan" })} />);
    expect(screen.queryByLabelText("Transparent background")).toBeNull();

    rerender(<TalkingAvatarPanel {...props({ avatarId: "harry-business" })} />);
    expect(screen.queryByLabelText("Transparent background")).toBeNull();

    rerender(<TalkingAvatarPanel {...props({ avatarId: "anika" })} />);
    expect(screen.queryByLabelText("Transparent background")).toBeNull();
  });

  it("explains when the browser cannot preserve WebM alpha", () => {
    render(
      <TalkingAvatarPanel
        {...props({ transparencySupported: false, transparent: true })}
      />,
    );

    expect(
      (screen.getByLabelText("Transparent background") as HTMLInputElement)
        .disabled,
    ).toBe(false);
    expect(screen.getByText(/cannot preserve WebM alpha/)).toBeTruthy();
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

  it("previews a ready video through its authenticated media route", () => {
    const panelProps = props({ job: readyJob });
    render(<TalkingAvatarPanel {...panelProps} />);

    expect(previewMock).toHaveBeenCalledWith(
      "/api/avatar/syntheses/avatar-1/video",
    );
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
