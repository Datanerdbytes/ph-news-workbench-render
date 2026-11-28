import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SECRET_INFOS,
  decryptAssemblyAiKey,
  decryptSecret,
  decryptToken,
  encryptAssemblyAiKey,
  encryptSecret,
  encryptToken,
} from "./facebook-token";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptSecret / decryptSecret round-trip", () => {
  it("recovers the original secret", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-123");
    const payload = encryptSecret("page-access-token", SECRET_INFOS.facebookPageToken);
    expect(decryptSecret(payload, SECRET_INFOS.facebookPageToken)).toBe(
      "page-access-token"
    );
  });

  it("produces versioned, non-deterministic payloads", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-123");
    const first = encryptToken("same-input");
    const second = encryptToken("same-input");
    expect(first.startsWith("v1.")).toBe(true);
    expect(first).not.toBe(second); // fresh IV every time
    expect(first.split(".")).toHaveLength(4);
  });
});

describe("AssemblyAI API key encryption", () => {
  it("round-trips a key without exposing it in the ciphertext", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-123");
    const key = "assemblyai-secret-key";
    const payload = encryptAssemblyAiKey(key);

    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain(key);
    expect(decryptAssemblyAiKey(payload)).toBe(key);
  });

  it("uses a different derivation from Facebook page tokens", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-123");
    const assemblyAiPayload = encryptAssemblyAiKey("shared-secret");
    const facebookPayload = encryptToken("shared-secret");

    expect(assemblyAiPayload).not.toBe(facebookPayload);
    expect(() => decryptToken(assemblyAiPayload)).toThrow();
    expect(() => decryptAssemblyAiKey(facebookPayload)).toThrow();
  });
});

describe("decryptSecret rejections", () => {
  it("binds decryption to the HKDF info label", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-123");
    const payload = encryptSecret("secret", SECRET_INFOS.facebookPageToken);
    // A different secret type derives a different key — never decryptable.
    expect(() =>
      decryptSecret(payload, SECRET_INFOS.llmProviderKey)
    ).toThrow();
  });

  it("rejects tampered ciphertext and malformed payloads", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-123");
    const payload = encryptToken("secret");
    const [version, iv, tag, ciphertext] = payload.split(".");

    const flipped = Buffer.from(ciphertext, "base64url");
    flipped[0] ^= 0xff;
    expect(() =>
      decryptSecret([version, iv, tag, flipped.toString("base64url")].join("."), SECRET_INFOS.facebookPageToken)
    ).toThrow();

    for (const bad of ["", "garbage", "v1.a.b", "v0.a.b.c", "plain.text"]) {
      expect(() => decryptSecret(bad, SECRET_INFOS.facebookPageToken)).toThrow(
        "Stored secret is not readable."
      );
    }

    const shortTag = Buffer.from("tooshort").toString("base64url");
    expect(() =>
      decryptSecret([version, iv, shortTag, ciphertext].join("."), SECRET_INFOS.facebookPageToken)
    ).toThrow("Stored secret is not readable.");
  });

  it("requires BETTER_AUTH_SECRET", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => encryptToken("secret")).toThrow(
      "BETTER_AUTH_SECRET is required to store encrypted secrets."
    );
  });
});
