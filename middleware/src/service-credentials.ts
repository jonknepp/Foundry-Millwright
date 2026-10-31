import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypt Foundry service credentials at rest. The 32-byte key must be supplied
 * independently of the SQLite database (e.g. a Docker secret).
 */
export function sealServiceCredential(value: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Invalid credential encryption key");
  if (!value || value.length > 4096) throw new Error("Invalid service credential");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openServiceCredential(encoded: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Invalid credential encryption key");
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid encrypted credential");
  const [, noncePart, tagPart, cipherPart] = parts;
  const nonce = Buffer.from(noncePart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(cipherPart, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 4096) {
    throw new Error("Invalid encrypted credential");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
