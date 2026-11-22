// GitHub may suppress masked job outputs. Pass only authenticated ciphertext
// between jobs; write the connection string to each job's environment file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

// Errors whose message is safe to print: raised before any secret-derived
// value flows through the script. Everything else falls back to a generic
// line, because a failure message can otherwise echo the connection string
// (for example a URL parse error quoting the URI it choked on).
class HandoffError extends Error {}

const FALLBACK =
  "E2E database handoff failed. Check the provisioner and the shared E2E_DB_HANDOFF_KEY.";

function main() {
  const key = process.env.E2E_DB_HANDOFF_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new HandoffError("E2E_DB_HANDOFF_KEY must be a 32-byte hex key.");
  }
  const output = process.env.GITHUB_OUTPUT;
  const environment = process.env.GITHUB_ENV;
  if (!output || !environment) {
    throw new HandoffError("GITHUB_OUTPUT / GITHUB_ENV are not set — this script runs inside Actions.");
  }
  const secret = Buffer.from(key, "hex");
  const aad = Buffer.from(`e2e-db:${process.env.GITHUB_RUN_ID}`);
  if (process.argv[2] === "encrypt") {
    const uri = process.env.E2E_DATABASE_URL;
    if (!uri) {
      throw new HandoffError("The provisioner did not set E2E_DATABASE_URL.");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(uri, "utf8"), cipher.final()]);
    const envelope = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    appendFileSync(output, `envelope=${envelope.toString("base64url")}\n`);
  } else if (process.argv[2] === "decrypt") {
    const envelope = Buffer.from(process.env.E2E_DB_ENVELOPE ?? "", "base64url");
    if (envelope.length < 12 + 16) {
      throw new HandoffError("E2E_DB_ENVELOPE is missing or malformed.");
    }
    let uri;
    try {
      const decipher = createDecipheriv("aes-256-gcm", secret, envelope.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(envelope.subarray(12, 28));
      uri = Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      // An authentication failure carries no secret, but the envelope is
      // untrusted input — keep this one generic too.
      throw new HandoffError("E2E_DB_ENVELOPE failed to open with this run's E2E_DB_HANDOFF_KEY.");
    }
    if (/[\r\n]/.test(uri)) {
      throw new HandoffError("The decrypted database URL is malformed.");
    }
    let password;
    try {
      password = new URL(uri).password;
    } catch {
      throw new HandoffError("The decrypted database URL is malformed.");
    }
    if (password) {
      console.log(`::add-mask::${decodeURIComponent(password)}`);
    }
    console.log(`::add-mask::${uri}`);
    appendFileSync(environment, `E2E_DATABASE_URL=${uri}\n`);
  } else {
    throw new HandoffError("Expected encrypt or decrypt.");
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof HandoffError ? error.message : FALLBACK);
  process.exitCode = 1;
}
