import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { encryptAssemblyAiKey } from "@/lib/facebook-token";
import { isTextModel } from "@/lib/models";
import { defaultTextModel } from "@/lib/openrouter";
import { requireWorkspace, unauthorized } from "@/lib/session";
import {
  DEFAULT_TTS_PROVIDER,
  isTtsProviderId,
  MAX_ASSEMBLYAI_CLONED_VOICES,
  MAX_ASSEMBLYAI_VOICE_ID_LENGTH,
  normalizeAssemblyAiVoiceIds,
  readAssemblyAiVoiceIds,
  type TtsProviderId,
} from "@/lib/tts/providers";

export const dynamic = "force-dynamic";

function ttsConfigured(
  provider: TtsProviderId,
  assemblyAiKeyConfigured: boolean,
): boolean {
  return provider === "assemblyai"
    ? assemblyAiKeyConfigured
    : Boolean(process.env.AZURE_SPEECH_KEY?.trim() && process.env.AZURE_SPEECH_REGION?.trim());
}

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const members = await sql`
    SELECT count(*)::int AS count
    FROM workspace_members
    WHERE workspace_id = ${access.workspace.id}`;

  return NextResponse.json(
    {
      id: access.workspace.id,
      name: access.workspace.name,
      role: access.workspace.role,
      memberCount: members[0]?.count ?? 1,
      aiModel: access.workspace.aiModel,
      defaultModel: defaultTextModel(),
      ttsProvider: access.workspace.ttsProvider,
      ttsConfigured: ttsConfigured(
        access.workspace.ttsProvider,
        access.workspace.assemblyAiKeyConfigured,
      ),
      assemblyAiKeyConfigured: access.workspace.assemblyAiKeyConfigured,
      assemblyAiVoiceIds: access.workspace.assemblyAiVoiceIds,
      user: { id: access.user.id, name: access.user.name },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  if (access.workspace.role !== "owner") {
    return NextResponse.json(
      { error: "Only workspace owners can change workspace settings." },
      { status: 403 },
    );
  }

  const parsed: unknown = await request.json().catch(() => null);
  const body =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  const hasName = typeof body.name === "string";
  const hasModel = "aiModel" in body;
  const hasProvider = "ttsProvider" in body;
  const hasKey = "assemblyaiApiKey" in body;
  const hasVoiceIds = "assemblyaiVoiceIds" in body;
  if (!hasName && !hasModel && !hasProvider && !hasKey && !hasVoiceIds) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  let name = access.workspace.name;
  if (hasName) {
    name = (body?.name as string).trim();
    if (name.length < 2 || name.length > 60) {
      return NextResponse.json(
        { error: "Workspace name must be between 2 and 60 characters." },
        { status: 400 },
      );
    }
  }

  let aiModel: string | null = access.workspace.aiModel;
  if (hasModel) {
    const value = body?.aiModel;
    if (value === null || value === "") {
      aiModel = null;
    } else if (typeof value === "string" && isTextModel(value)) {
      aiModel = value;
    } else {
      return NextResponse.json(
        { error: "That model is not available." },
        { status: 400 },
      );
    }
  }

  let ttsProvider = access.workspace.ttsProvider;
  if (hasProvider) {
    if (!isTtsProviderId(body?.ttsProvider)) {
      return NextResponse.json(
        { error: "That text-to-speech provider is not available." },
        { status: 400 },
      );
    }
    ttsProvider = body.ttsProvider;
  }

  let encryptedKey: string | null = null;
  if (hasKey) {
    const value = body.assemblyaiApiKey;
    if (value === null) {
      encryptedKey = null;
    } else if (typeof value === "string") {
      const key = value.trim();
      if (!key || key.length > 4096) {
        return NextResponse.json(
          { error: "Enter a valid AssemblyAI API key." },
          { status: 400 },
        );
      }
      try {
        encryptedKey = encryptAssemblyAiKey(key);
      } catch {
        return NextResponse.json(
          { error: "The server cannot save encrypted API keys." },
          { status: 503 },
        );
      }
    } else {
      return NextResponse.json(
        { error: "Enter a valid AssemblyAI API key." },
        { status: 400 },
      );
    }
  }

  let assemblyAiVoiceIds = access.workspace.assemblyAiVoiceIds;
  if (hasVoiceIds) {
    const normalized = normalizeAssemblyAiVoiceIds(body.assemblyaiVoiceIds);
    if (!normalized) {
      return NextResponse.json(
        { error: `Enter up to ${MAX_ASSEMBLYAI_CLONED_VOICES} valid AssemblyAI voice IDs, each no longer than ${MAX_ASSEMBLYAI_VOICE_ID_LENGTH} characters.` },
        { status: 400 },
      );
    }
    assemblyAiVoiceIds = normalized;
  }

  const rows = (await sql`
    UPDATE workspaces
    SET name = CASE WHEN ${hasName}::boolean THEN ${name}::text ELSE name END,
        ai_model = CASE WHEN ${hasModel}::boolean THEN ${aiModel}::text ELSE ai_model END,
        tts_provider = CASE
          WHEN ${hasProvider}::boolean THEN ${ttsProvider}::text
          ELSE tts_provider
        END,
        assemblyai_api_key_encrypted = CASE
          WHEN ${hasKey}::boolean THEN ${encryptedKey}::text
          ELSE assemblyai_api_key_encrypted
        END,
        assemblyai_voice_ids = CASE
          WHEN ${hasVoiceIds}::boolean THEN ${JSON.stringify(assemblyAiVoiceIds)}::jsonb
          ELSE assemblyai_voice_ids
        END
    WHERE id = ${access.workspace.id}
      AND (
        (CASE
          WHEN ${hasProvider}::boolean THEN ${ttsProvider}::text
          ELSE tts_provider
        END) <> 'assemblyai'
        OR (${hasKey}::boolean AND ${encryptedKey}::text IS NOT NULL)
        OR assemblyai_api_key_encrypted IS NOT NULL
      )
    RETURNING name, ai_model, tts_provider, assemblyai_voice_ids,
      (assemblyai_api_key_encrypted IS NOT NULL) AS assemblyai_key_configured`) as unknown as Array<{
    name: string;
    ai_model: string | null;
    tts_provider: string;
    assemblyai_voice_ids: unknown;
    assemblyai_key_configured: boolean;
  }>;

  const updated = rows[0];
  if (!updated) {
    return NextResponse.json(
      {
        error: "Add an AssemblyAI API key before selecting AssemblyAI.",
        code: "assemblyai_key_required",
      },
      { status: 400 },
    );
  }

  const updatedProvider = isTtsProviderId(updated.tts_provider)
    ? updated.tts_provider
    : DEFAULT_TTS_PROVIDER;
  const assemblyAiKeyConfigured = updated.assemblyai_key_configured === true;
  const updatedVoiceIds = readAssemblyAiVoiceIds(updated.assemblyai_voice_ids);

  return NextResponse.json({
    id: access.workspace.id,
    name: updated.name,
    aiModel: updated.ai_model,
    ttsProvider: updatedProvider,
    ttsConfigured: ttsConfigured(updatedProvider, assemblyAiKeyConfigured),
    assemblyAiKeyConfigured,
    assemblyAiVoiceIds: updatedVoiceIds,
  });
}
