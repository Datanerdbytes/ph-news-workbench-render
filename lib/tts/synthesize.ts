import { sql } from "@/lib/db";
import { decryptAssemblyAiKey } from "@/lib/facebook-token";
import type { Workspace } from "@/lib/workspaces";
import { synthesizeAssemblyAiSpeech } from "./assemblyai";
import { synthesizeSpeech } from "./azure";
import { TtsError, type TtsSynthesisResult } from "./shared";
import { isTtsVoiceId } from "./voices";

export async function synthesizeWorkspaceSpeech(input: {
  workspace: Pick<Workspace, "id" | "ttsProvider" | "assemblyAiVoiceIds">;
  text: string;
  voiceId: string;
  speed: number;
  correlationId: string;
}): Promise<TtsSynthesisResult> {
  if (input.workspace.ttsProvider === "assemblyai") {
    const rows = (await sql`
      SELECT assemblyai_api_key_encrypted
      FROM workspaces
      WHERE id = ${input.workspace.id}`) as unknown as Array<{
      assemblyai_api_key_encrypted: string | null;
    }>;
    const encryptedKey = rows[0]?.assemblyai_api_key_encrypted;
    if (!encryptedKey) {
      throw new TtsError(
        503,
        "not_configured",
        "AssemblyAI is not configured. Add an API key in Settings.",
      );
    }

    let apiKey: string;
    try {
      apiKey = decryptAssemblyAiKey(encryptedKey);
    } catch {
      throw new TtsError(
        503,
        "not_configured",
        "The saved AssemblyAI API key cannot be read. Save it again in Settings.",
      );
    }
    return synthesizeAssemblyAiSpeech({
      text: input.text,
      voiceId: input.voiceId,
      speed: input.speed,
      apiKey,
      clonedVoiceIds: input.workspace.assemblyAiVoiceIds,
      workspaceId: input.workspace.id,
      correlationId: input.correlationId,
    });
  }

  if (!isTtsVoiceId(input.voiceId)) {
    throw new TtsError(400, "invalid_voice", "Choose a supported Azure voice.");
  }
  return synthesizeSpeech({
    text: input.text,
    voiceId: input.voiceId,
    speed: input.speed,
    workspaceId: input.workspace.id,
    correlationId: input.correlationId,
  });
}
