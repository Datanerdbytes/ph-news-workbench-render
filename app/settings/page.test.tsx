// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsProviderId } from "@/lib/tts/providers";

const { toastMock } = vi.hoisted(() => ({
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children?: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/facebook-connection", () => ({
  useFacebookConnection: () => ({
    loading: false,
    connected: false,
    refreshing: false,
    page: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("@/components/publishing/page-selection", () => ({
  PageAvatar: () => null,
  useManagedPages: () => ({ pages: [], setPrimaryPage: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: "Test Owner", email: "owner@example.com" } },
    }),
    changePassword: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));

import SettingsPage from "./page";

type Workspace = {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  aiModel: string | null;
  defaultModel: string;
  ttsProvider: TtsProviderId;
  ttsConfigured: boolean;
  assemblyAiKeyConfigured: boolean;
  assemblyAiVoiceIds: string[];
};

const baseWorkspace: Workspace = {
  id: "workspace-1",
  name: "Test Newsroom",
  role: "owner",
  memberCount: 2,
  aiModel: null,
  defaultModel: "google/gemma-4-31b-it:free",
  ttsProvider: "azure",
  ttsConfigured: true,
  assemblyAiKeyConfigured: false,
  assemblyAiVoiceIds: [],
};

const fetchMock = vi.fn();
let workspace: Workspace;
let patchResponse: Response | null;

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

function ttsSection() {
  return screen.getByRole("heading", { name: "Text-to-speech" }).closest("section")!;
}

async function renderSettings() {
  const view = render(<SettingsPage />);
  await waitFor(() =>
    expect(
      within(ttsSection()).getByRole("radio", { name: /^Azure Speech/ }),
    ).toBeEnabled(),
  );
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace = { ...baseWorkspace };
  patchResponse = null;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/workspace") {
      if (init?.method === "PATCH") {
        if (patchResponse) return patchResponse;
        const body = JSON.parse(String(init.body));
        if (body.ttsProvider) {
          workspace = {
            ...workspace,
            ttsProvider: body.ttsProvider,
            ttsConfigured:
              body.ttsProvider === "azure" || workspace.assemblyAiKeyConfigured,
          };
        }
        if (Object.hasOwn(body, "assemblyaiApiKey")) {
          workspace = {
            ...workspace,
            assemblyAiKeyConfigured: body.assemblyaiApiKey !== null,
            ...(body.assemblyaiApiKey === null
              ? { ttsProvider: "azure" as const, ttsConfigured: true }
              : {}),
          };
        }
        if (Object.hasOwn(body, "assemblyaiVoiceIds")) {
          workspace = {
            ...workspace,
            assemblyAiVoiceIds: body.assemblyaiVoiceIds,
          };
        }
        return jsonResponse(workspace);
      }
      return jsonResponse(workspace);
    }
    if (url === "/api/preferences") {
      return jsonResponse({ theme: "ink-white" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPage text-to-speech", () => {
  it("exposes accessible provider and password controls without displaying a saved secret", async () => {
    await renderSettings();
    const section = within(ttsSection());
    const azure = section.getByRole("radio", { name: /^Azure Speech/ });
    const assemblyai = section.getByRole("radio", { name: /^AssemblyAI/ });
    const keyInput = section.getByLabelText("AssemblyAI API key");
    const voiceIdsInput = section.getByLabelText("AssemblyAI cloned voice IDs");

    expect(
      section.getByRole("radiogroup", { name: "Text-to-speech provider" }),
    ).toBeInTheDocument();
    expect(azure).toHaveAttribute("aria-checked", "true");
    expect(assemblyai).toHaveAttribute("aria-checked", "false");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(keyInput).toHaveAttribute("autocomplete", "off");
    expect(keyInput).toHaveValue("");
    expect(keyInput).toHaveAccessibleDescription(/encrypted at rest and never returned/);
    expect(voiceIdsInput).toHaveValue("");
    expect(voiceIdsInput).toHaveAccessibleDescription(/one cloned voice ID per line/);
    expect(section.getByRole("button", { name: "Save voice IDs" })).toBeEnabled();
    expect(section.getByRole("button", { name: "Save key" })).toBeDisabled();
    expect(section.queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(section.getByText("No AssemblyAI API key saved.")).toBeInTheDocument();
    expect(
      section.getByText("Azure Speech is ready for voice-over generation."),
    ).toBeInTheDocument();
    expect(ttsSection()).not.toHaveTextContent("assemblyai-test-secret");
  });

  it("saves an AssemblyAI key, clears the password, and never renders the secret", async () => {
    const secret = "assemblyai-test-secret";
    await renderSettings();
    const section = within(ttsSection());
    const keyInput = section.getByLabelText("AssemblyAI API key");

    fireEvent.change(keyInput, { target: { value: secret } });
    expect(section.getByRole("button", { name: "Save key" })).toBeEnabled();
    fireEvent.click(section.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assemblyaiApiKey: secret }),
      }),
    );
    expect(await section.findByText("API key saved.")).toBeInTheDocument();
    expect(keyInput).toHaveValue("");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(section.getByRole("button", { name: "Save key" })).toBeDisabled();
    expect(section.getByRole("button", { name: "Remove key" })).toBeEnabled();
    expect(ttsSection()).not.toHaveTextContent(secret);
    expect(JSON.stringify(toastMock.success.mock.calls)).not.toContain(secret);
  });

  it("confirms key removal and switches an active AssemblyAI workspace back to Azure", async () => {
    workspace = {
      ...baseWorkspace,
      ttsProvider: "assemblyai",
      assemblyAiKeyConfigured: true,
    };
    await renderSettings();
    const section = within(ttsSection());

    fireEvent.click(section.getByRole("button", { name: "Remove key" }));
    expect(
      section.getByRole("button", { name: "Confirm removal" }),
    ).toBeInTheDocument();
    fireEvent.click(section.getByRole("button", { name: "Confirm removal" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assemblyaiApiKey: null, ttsProvider: "azure" }),
      }),
    );
    await waitFor(() =>
      expect(section.getByRole("radio", { name: /^Azure Speech/ })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(section.getByText("No AssemblyAI API key saved.")).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(section.getByLabelText("AssemblyAI API key")).toHaveValue("");
    expect(
      section.getByText("Azure Speech is ready for voice-over generation."),
    ).toBeInTheDocument();
  });

  it("switches to a configured AssemblyAI provider and updates its status", async () => {
    workspace = { ...baseWorkspace, assemblyAiKeyConfigured: true };
    await renderSettings();
    const section = within(ttsSection());

    fireEvent.click(section.getByRole("radio", { name: /^AssemblyAI/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttsProvider: "assemblyai" }),
      }),
    );
    await waitFor(() =>
      expect(section.getByRole("radio", { name: /^AssemblyAI/ })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(
      section.getByText("AssemblyAI is ready for voice-over generation."),
    ).toBeInTheDocument();
  });

  it("blocks switching without a key and announces the requirement inline", async () => {
    await renderSettings();
    const section = within(ttsSection());

    fireEvent.click(section.getByRole("radio", { name: /^AssemblyAI/ }));

    expect(section.getByRole("alert")).toHaveTextContent(
      "Save an AssemblyAI API key below before switching providers.",
    );
    expect(section.getByRole("radio", { name: /^Azure Speech/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
  });

  it("saves normalized cloned voice IDs one per line", async () => {
    await renderSettings();
    const section = within(ttsSection());
    const voiceIdsInput = section.getByLabelText("AssemblyAI cloned voice IDs");

    fireEvent.change(voiceIdsInput, {
      target: { value: " cloned-one \n\ncloned-two\nCLONED-ONE" },
    });
    fireEvent.click(section.getByRole("button", { name: "Save voice IDs" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assemblyaiVoiceIds: ["cloned-one", "cloned-two"],
        }),
      }),
    );
    expect(await section.findByText("2 cloned voices saved.")).toBeInTheDocument();
    expect(voiceIdsInput).toHaveValue("cloned-one\ncloned-two");
  });

  it("clears cloned voice IDs when the textarea is emptied", async () => {
    workspace = { ...baseWorkspace, assemblyAiVoiceIds: ["cloned-voice"] };
    await renderSettings();
    const section = within(ttsSection());
    const voiceIdsInput = section.getByLabelText("AssemblyAI cloned voice IDs");

    fireEvent.change(voiceIdsInput, { target: { value: "" } });
    fireEvent.click(section.getByRole("button", { name: "Save voice IDs" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assemblyaiVoiceIds: [] }),
      }),
    );
    expect(await section.findByText("0 cloned voices saved.")).toBeInTheDocument();
  });

  it("rejects invalid cloned voice IDs before sending a request", async () => {
    await renderSettings();
    const section = within(ttsSection());

    fireEvent.change(section.getByLabelText("AssemblyAI cloned voice IDs"), {
      target: { value: "bad id" },
    });
    fireEvent.click(section.getByRole("button", { name: "Save voice IDs" }));

    expect(section.getByRole("alert")).toHaveTextContent(
      "Enter up to 20 valid AssemblyAI voice IDs",
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
  });

  it("surfaces key-save failures as an inline alert", async () => {
    patchResponse = jsonResponse(
      { error: "AssemblyAI rejected this key." },
      false,
    );
    await renderSettings();
    const section = within(ttsSection());

    fireEvent.change(section.getByLabelText("AssemblyAI API key"), {
      target: { value: "assemblyai-test-secret" },
    });
    fireEvent.click(section.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(section.getByRole("alert")).toHaveTextContent(
        "AssemblyAI rejected this key.",
      ),
    );
    expect(section.getByText("No AssemblyAI API key saved.")).toBeInTheDocument();
    expect(ttsSection()).not.toHaveTextContent("assemblyai-test-secret");
  });
});
