import { stripMarkdown } from "@/lib/format";

export const MAX_TTS_CHARACTERS = 5000;

export function normalizeSpeechText(input: string): string {
  const withoutLinks = input
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s]+/g, "");
  return stripMarkdown(withoutLinks).replace(/\s+/g, " ").trim();
}
