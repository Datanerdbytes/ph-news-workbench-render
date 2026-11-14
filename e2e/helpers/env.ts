import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: Record<string, string> | null = null;

/**
 * Minimal .env.local reader — Playwright runs outside Next, which owns real
 * env loading, and the suite must never hardcode credentials. The file is
 * optional: CI has no .env.local and feeds the same keys as real environment
 * variables.
 */
export function envLocal(): Record<string, string> {
  if (cached) return cached;
  cached = {};
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  } catch {
    return cached;
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      cached[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return cached;
}

export function requireEnv(key: string): string {
  const value = process.env[key] ?? envLocal()[key];
  if (!value) {
    throw new Error(
      `${key} is missing — set it in .env.local locally or as an environment variable in CI`
    );
  }
  return value;
}
