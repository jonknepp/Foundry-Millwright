import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getStoredServiceCredential, storeServiceCredential } from "./database.js";
import { openServiceCredential, sealServiceCredential } from "./service-credentials.js";

export type ProvisioningResult = "created" | "already-provisioned";

/**
 * Internal credential handoff primitive. Call ONLY after a separately verified
 * server-side Foundry authorization exchange; never expose directly to browsers.
 * Refuses to adopt or overwrite a different service account for the same world.
 */
export function commitServiceAccountProvisioning(
  db: DatabaseSync,
  key: Buffer,
  worldId: string,
  foundryUserId: string,
  password: string,
  now = Date.now()
): ProvisioningResult {
  if (!worldId || worldId.length > 128 || !foundryUserId || foundryUserId.length > 128 ||
      typeof password !== "string" || password.length < 24 || password.length > 1024 ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid service account provisioning request");
  }
  // Validate encryption key before starting a write transaction.
  const encrypted = sealServiceCredential(password, key);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = getStoredServiceCredential(db, worldId);
    if (existing) {
      const previous = Buffer.from(openServiceCredential(existing.encryptedPassword, key), "utf8");
      const candidate = Buffer.from(password, "utf8");
      const samePassword = previous.length === candidate.length &&
        timingSafeEqual(previous, candidate);
      if (existing.foundryUserId !== foundryUserId || !samePassword) {
        throw new Error("Service account already provisioned; explicit recovery required");
      }
      db.exec("COMMIT");
      return "already-provisioned";
    }
    storeServiceCredential(db, worldId, foundryUserId, encrypted, now);
    db.exec("COMMIT");
    return "created";
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
