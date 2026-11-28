import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { sqlMock, requireWorkspaceMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: sqlMock }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@/lib/facebook-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/facebook-token")>();
  return {
    ...actual,
    encryptAssemblyAiKey: vi.fn(actual.encryptAssemblyAiKey),
  };
});

import {
  decryptAssemblyAiKey,
  encryptAssemblyAiKey,
} from "@/lib/facebook-token";
import { GET, PATCH } from "./route";

const sql = sqlMock as unknown as Mock;
const encryptKeyMock = encryptAssemblyAiKey as unknown as Mock;
const ownerAccess = {
  user: { id: "u1", name: "Alice" },
  workspace: {
    id: "ws1",
    name: "Newsroom",
    role: "owner",
    ownerId: "u1",
    aiModel: null,
    ttsProvider: "azure" as const,
    assemblyAiKeyConfigured: false,
    assemblyAiVoiceIds: [],
  },
};

function get() {
  return GET(new Request("http://localhost/api/workspace"));
}

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patchRaw(body: string) {
  return PATCH(
    new Request("http://localhost/api/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

function queryText(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join(" ");
}

function workspaceUpdateCall(): unknown[] {
  const calls = sql.mock.calls.filter((call: unknown[]) =>
    queryText(call).includes("UPDATE workspaces"),
  );
  expect(calls).toHaveLength(1);
  return calls[0];
}

function returningUpdate(
  ttsProvider: "azure" | "assemblyai",
  assemblyAiKeyConfigured: boolean,
) {
  sql.mockResolvedValue([
    {
      name: "Newsroom",
      ai_model: null,
      tts_provider: ttsProvider,
      assemblyai_voice_ids: [],
      assemblyai_key_configured: assemblyAiKeyConfigured,
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sql.mockReset();
  requireWorkspaceMock.mockResolvedValue(ownerAccess);
  sql.mockResolvedValue([{ count: 4 }]);
  vi.stubEnv("BETTER_AUTH_SECRET", "workspace-route-test-secret");
  vi.stubEnv("AZURE_SPEECH_KEY", "azure-test-key");
  vi.stubEnv("AZURE_SPEECH_REGION", "southeastasia");
  vi.stubEnv("OPENROUTER_MODEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/workspace", () => {
  it("requires a workspace session before reading membership", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await get();

    expect(response.status).toBe(401);
    expect(sql).not.toHaveBeenCalled();
  });

  it("returns provider configuration to members without exposing key material", async () => {
    const plaintextKey = "plaintext-assemblyai-key";
    requireWorkspaceMock.mockResolvedValue({
      ...ownerAccess,
      workspace: {
        ...ownerAccess.workspace,
        role: "editor",
        ttsProvider: "assemblyai",
        assemblyAiKeyConfigured: true,
        assemblyAiVoiceIds: ["cloned-voice-id"],
        assemblyaiApiKey: plaintextKey,
      },
    });

    const response = await get();
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      id: "ws1",
      name: "Newsroom",
      role: "editor",
      memberCount: 4,
      aiModel: null,
      defaultModel: "google/gemma-4-31b-it:free",
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiKeyConfigured: true,
      assemblyAiVoiceIds: ["cloned-voice-id"],
      user: { id: "u1", name: "Alice" },
    });
    expect(body).not.toHaveProperty("assemblyaiApiKey");
    expect(body).not.toHaveProperty("assemblyai_api_key_encrypted");
    expect(responseText).not.toContain(plaintextKey);
    expect(sql.mock.calls[0].slice(1)).toEqual(["ws1"]);
  });

  it.each([
    { key: "", region: "", configured: false },
    { key: "azure-key", region: "", configured: false },
    { key: "", region: "eastus", configured: false },
    { key: "azure-key", region: "eastus", configured: true },
  ])("reports Azure configuration as $configured", async ({ key, region, configured }) => {
    vi.stubEnv("AZURE_SPEECH_KEY", key);
    vi.stubEnv("AZURE_SPEECH_REGION", region);

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ttsProvider: "azure",
      ttsConfigured: configured,
      assemblyAiKeyConfigured: false,
    });
  });
});

describe("PATCH /api/workspace", () => {
  it("requires a workspace session", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await patch({ assemblyaiApiKey: "secret-key" });

    expect(response.status).toBe(401);
    expect(encryptKeyMock).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("allows only owners to change provider settings", async () => {
    requireWorkspaceMock.mockResolvedValue({
      ...ownerAccess,
      workspace: { ...ownerAccess.workspace, role: "editor" },
    });

    const response = await patch({
      ttsProvider: "assemblyai",
      assemblyaiApiKey: "secret-key",
    });

    expect(response.status).toBe(403);
    expect(encryptKeyMock).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and empty updates", async () => {
    const malformed = await patchRaw("{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Nothing to update." });

    const empty = await patch({});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Nothing to update." });
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON instead of throwing", async () => {
    const response = await patchRaw("42");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Nothing to update." });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(["openai", "", "AZURE", null, 1, {}])(
    "rejects the unsupported provider %j",
    async (ttsProvider) => {
      const response = await patch({ ttsProvider });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "That text-to-speech provider is not available.",
      });
      expect(encryptKeyMock).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    },
  );

  it("requires a saved key before selecting AssemblyAI", async () => {
    sql.mockResolvedValue([]);

    const response = await patch({ ttsProvider: "assemblyai" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Add an AssemblyAI API key before selecting AssemblyAI.",
      code: "assemblyai_key_required",
    });
    expect(encryptKeyMock).not.toHaveBeenCalled();
    expect(workspaceUpdateCall()).toBeDefined();
  });

  it("rejects removing the key while the current database provider is AssemblyAI", async () => {
    sql.mockResolvedValue([]);

    const response = await patch({ assemblyaiApiKey: null });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Add an AssemblyAI API key before selecting AssemblyAI.",
      code: "assemblyai_key_required",
    });
    expect(workspaceUpdateCall()).toBeDefined();
  });

  it("encrypts and persists a trimmed key when selecting AssemblyAI", async () => {
    returningUpdate("assemblyai", true);
    const plaintextKey = "  saved-assemblyai-key  ";

    const response = await patch({
      ttsProvider: "assemblyai",
      assemblyaiApiKey: plaintextKey,
    });
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(encryptKeyMock).toHaveBeenCalledWith("saved-assemblyai-key");
    const encryptedKey = encryptKeyMock.mock.results[0].value as string;
    expect(encryptedKey.startsWith("v1.")).toBe(true);
    expect(encryptedKey).not.toContain("saved-assemblyai-key");
    expect(decryptAssemblyAiKey(encryptedKey)).toBe("saved-assemblyai-key");

    const update = workspaceUpdateCall();
    const text = queryText(update);
    expect(text).toContain("assemblyai_api_key_encrypted = CASE");
    expect(text).toContain("ELSE assemblyai_api_key_encrypted");
    expect(text).toContain("tts_provider = CASE");
    expect(text).toContain("::boolean AND  ::text IS NOT NULL");
    expect(text).toContain("OR assemblyai_api_key_encrypted IS NOT NULL");
    expect(update[1]).toBe(false);
    expect(update[2]).toBe("Newsroom");
    expect(update[3]).toBe(false);
    expect(update[4]).toBeNull();
    expect(update.slice(5, 9)).toEqual([
      true,
      "assemblyai",
      true,
      encryptedKey,
    ]);
    expect(update.slice(9)).toEqual([
      false,
      "[]",
      "ws1",
      true,
      "assemblyai",
      true,
      encryptedKey,
    ]);
    expect(body).toMatchObject({
      id: "ws1",
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiKeyConfigured: true,
    });
    expect(body).not.toHaveProperty("assemblyaiApiKey");
    expect(body).not.toHaveProperty("assemblyai_api_key_encrypted");
    expect(responseText).not.toContain("saved-assemblyai-key");
    expect(responseText).not.toContain(encryptedKey);
  });

  it("does not overwrite a provider selected after the request snapshot", async () => {
    returningUpdate("assemblyai", true);

    const response = await patch({ assemblyaiApiKey: "saved-key" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiKeyConfigured: true,
    });
    const encryptedKey = encryptKeyMock.mock.results[0].value as string;
    const update = workspaceUpdateCall();
    expect(queryText(update)).toContain("ELSE tts_provider");
    expect(update[5]).toBe(false);
    expect(update[9]).toBe(false);
    expect(update[10]).toBe("[]");
    expect(update[12]).toBe(false);
    expect(update[13]).toBe("azure");
    expect(update[14]).toBe(true);
    expect(update[15]).toBe(encryptedKey);
    expect(decryptAssemblyAiKey(encryptedKey)).toBe("saved-key");
  });

  it("reports the current configuration when only the key changes", async () => {
    requireWorkspaceMock.mockResolvedValue({
      ...ownerAccess,
      workspace: {
        ...ownerAccess.workspace,
        ttsProvider: "assemblyai",
        assemblyAiKeyConfigured: true,
      },
    });
    returningUpdate("assemblyai", true);

    const response = await patch({ assemblyaiApiKey: "saved-key" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiKeyConfigured: true,
    });
  });

  it("preserves an existing encrypted key when only the provider changes", async () => {
    requireWorkspaceMock.mockResolvedValue({
      ...ownerAccess,
      workspace: {
        ...ownerAccess.workspace,
        assemblyAiKeyConfigured: true,
      },
    });
    returningUpdate("assemblyai", true);

    const response = await patch({ ttsProvider: "assemblyai" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiKeyConfigured: true,
    });
    expect(encryptKeyMock).not.toHaveBeenCalled();
    const update = workspaceUpdateCall();
    expect(queryText(update)).toContain("ELSE assemblyai_api_key_encrypted");
    expect(update[5]).toBe(true);
    expect(update[6]).toBe("assemblyai");
    expect(update[7]).toBe(false);
    expect(update[8]).toBeNull();
  });

  it("clears the encrypted key and falls back to Azure atomically", async () => {
    requireWorkspaceMock.mockResolvedValue({
      ...ownerAccess,
      workspace: {
        ...ownerAccess.workspace,
        ttsProvider: "assemblyai",
        assemblyAiKeyConfigured: true,
      },
    });
    returningUpdate("azure", false);

    const response = await patch({
      assemblyaiApiKey: null,
      ttsProvider: "azure",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ttsProvider: "azure",
      ttsConfigured: true,
      assemblyAiKeyConfigured: false,
    });
    expect(encryptKeyMock).not.toHaveBeenCalled();
    const update = workspaceUpdateCall();
    expect(update[5]).toBe(true);
    expect(update[6]).toBe("azure");
    expect(update[7]).toBe(true);
    expect(update[8]).toBeNull();
  });

  it("normalizes and persists AssemblyAI cloned voice IDs", async () => {
    sql.mockResolvedValue([
      {
        name: "Newsroom",
        ai_model: null,
        tts_provider: "azure",
        assemblyai_voice_ids: ["cloned-one", "cloned-two"],
        assemblyai_key_configured: false,
      },
    ]);

    const response = await patch({
      assemblyaiVoiceIds: [" cloned-one ", "cloned-two", "CLONED-ONE"],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      assemblyAiVoiceIds: ["cloned-one", "cloned-two"],
    });
    const update = workspaceUpdateCall();
    expect(queryText(update)).toContain("assemblyai_voice_ids = CASE");
    expect(update[9]).toBe(true);
    expect(update[10]).toBe('["cloned-one","cloned-two"]');
  });

  it("allows clearing all cloned voice IDs", async () => {
    sql.mockResolvedValue([
      {
        name: "Newsroom",
        ai_model: null,
        tts_provider: "azure",
        assemblyai_voice_ids: [],
        assemblyai_key_configured: false,
      },
    ]);

    const response = await patch({ assemblyaiVoiceIds: [] });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ assemblyAiVoiceIds: [] });
    expect(workspaceUpdateCall()[10]).toBe("[]");
  });

  it.each([
    { label: "a non-array", value: "cloned-voice" },
    { label: "a blank ID", value: [""] },
    { label: "whitespace", value: ["bad id"] },
    { label: "an oversized ID", value: ["x".repeat(65)] },
    { label: "a non-string ID", value: [1] },
    { label: "too many IDs", value: Array.from({ length: 21 }, (_, index) => `voice-${index}`) },
  ])("rejects $label before updating the workspace", async ({ value }) => {
    const response = await patch({ assemblyaiVoiceIds: value });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Enter up to 20 valid AssemblyAI voice IDs, each no longer than 64 characters.",
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", value: "" },
    { label: "blank", value: "   " },
    { label: "oversized", value: "x".repeat(4097) },
    { label: "numeric", value: 123 },
    { label: "object", value: {} },
    { label: "array", value: [] },
  ])(
    "rejects the $label API key",
    async ({ value: assemblyaiApiKey }) => {
      const response = await patch({ assemblyaiApiKey });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Enter a valid AssemblyAI API key.",
      });
      expect(encryptKeyMock).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    },
  );

  it("returns a safe error when encryption is unavailable", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");

    const response = await patch({
      ttsProvider: "assemblyai",
      assemblyaiApiKey: "saved-secret-key",
    });
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(responseText)).toEqual({
      error: "The server cannot save encrypted API keys.",
    });
    expect(responseText).not.toContain("saved-secret-key");
    expect(sql).not.toHaveBeenCalled();
  });

  it("updates existing workspace fields in the same statement", async () => {
    sql.mockResolvedValue([
      {
        name: "Renamed Newsroom",
        ai_model: "google/gemma-4-31b-it:free",
        tts_provider: "azure",
        assemblyai_voice_ids: [],
        assemblyai_key_configured: false,
      },
    ]);

    const response = await patch({
      name: "Renamed Newsroom",
      aiModel: "google/gemma-4-31b-it:free",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "Renamed Newsroom",
      aiModel: "google/gemma-4-31b-it:free",
      ttsProvider: "azure",
    });
    const update = workspaceUpdateCall();
    expect(update[1]).toBe(true);
    expect(update[2]).toBe("Renamed Newsroom");
    expect(update[3]).toBe(true);
    expect(update[4]).toBe("google/gemma-4-31b-it:free");
    expect(update[5]).toBe(false);
    expect(update[9]).toBe(false);
    expect(update[10]).toBe("[]");
  });

  it.each([
    { body: { name: "x" }, error: "Workspace name must be between 2 and 60 characters." },
    { body: { aiModel: "not-a-model" }, error: "That model is not available." },
  ])("still validates existing workspace fields: $body", async ({ body, error }) => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(sql).not.toHaveBeenCalled();
  });
});
