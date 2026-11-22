// GitHub may suppress masked job outputs. Pass only authenticated ciphertext
// between jobs; write the connection string to each job's environment file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

function main() {
  const key = process.env.E2E_DB_HANDOFF_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error("E2E_DB_HANDOFF_KEY must be a 32-byte hex key.");
  }
  const secret = Buffer.from(key, "hex");
  const aad = Buffer.from(`e2e-db:${process.env.GITHUB_RUN_ID}`);
  if (process.argv[2] === "encrypt") {
    const uri = process.env.E2E_DATABASE_URL;
    if (!uri) throw new Error("The provisioner did not set E2E_DATABASE_URL.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(uri, "utf8"), cipher.final()]);
    const envelope = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    appendFileSync(process.env.GITHUB_OUTPUT, `envelope=${envelope.toString("base64url")}\n`);
  } else if (process.argv[2] === "decrypt") {
    const envelope = Buffer.from(process.env.E2E_DB_ENVELOPE ?? "", "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secret, envelope.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.subarray(12, 28));
    const uri = Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString("utf8");
    if (/[\r\n]/.test(uri)) throw new Error("Invalid database URL.");
    const { password } = new URL(uri);
    if (password) console.log(`::add-mask::${decodeURIComponent(password)}`);
    console.log(`::add-mask::${uri}`);
    appendFileSync(process.env.GITHUB_ENV, `E2E_DATABASE_URL=${uri}\n`);
  } else {
    throw new Error("Expected encrypt or decrypt.");
  }
}

try {
  main();
} catch {
  // URL parse errors can include the connection string.
  console.error("E2E database handoff failed. Check the provisioner and the shared E2E_DB_HANDOFF_KEY.");
  process.exitCode = 1;
}
