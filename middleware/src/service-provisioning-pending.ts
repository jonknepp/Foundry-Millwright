import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getStoredServiceCredential } from "./database.js";
import { openServiceCredential, sealServiceCredential } from "./service-credentials.js";

export type PendingProvisioning = { worldId: string; encryptedPassword: string; createdAt: number; foundryUserId: string | null };

function validateWorldId(worldId: string): void {
  if (typeof worldId !== "string" || !worldId || worldId.length > 128) throw new Error("Invalid world ID");
}

/** Internal operation; caller must enforce Millwright administrator authorization. */
export function prepareServiceProvisioning(db: DatabaseSync, key: Buffer, worldId: string, now = Date.now()): { password: string; resumed: boolean } {
  validateWorldId(worldId);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid timestamp");
  if (key.length !== 32) throw new Error("Invalid credential encryption key");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (getStoredServiceCredential(db, worldId)) throw new Error("Service account already provisioned");
    const existing = db.prepare("SELECT encrypted_password AS encryptedPassword FROM service_provisioning WHERE world_id = ?")
      .get(worldId) as { encryptedPassword: string } | undefined;
    if (existing) {
      const password = openServiceCredential(existing.encryptedPassword, key);
      db.exec("COMMIT");
      return { password, resumed: true };
    }
    const password = randomBytes(48).toString("base64url");
    const encrypted = sealServiceCredential(password, key);
    db.prepare("INSERT INTO service_provisioning(world_id, encrypted_password, created_at, foundry_user_id) VALUES (?, ?, ?, NULL)")
      .run(worldId, encrypted, now);
    db.exec("COMMIT");
    return { password, resumed: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getPendingServiceProvisioning(db: DatabaseSync, worldId: string): PendingProvisioning | null {
  validateWorldId(worldId);
  return (db.prepare("SELECT world_id AS worldId, encrypted_password AS encryptedPassword, created_at AS createdAt, foundry_user_id AS foundryUserId FROM service_provisioning WHERE world_id = ?")
    .get(worldId) as PendingProvisioning | undefined) ?? null;
}
