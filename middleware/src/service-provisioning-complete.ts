import type { DatabaseSync } from "node:sqlite";
import { getStoredServiceCredential } from "./database.js";
import { openServiceCredential, sealServiceCredential } from "./service-credentials.js";
import { getPendingServiceProvisioning } from "./service-provisioning-pending.js";

export type VerifyFoundryServiceAccount = (input: {
  worldId: string;
  foundryUserId: string;
  password: string;
}) => Promise<boolean>;

/**
 * The verifier must independently authenticate to Foundry using the
 * provisioned account ID and password, and require Foundry's explicit
 * HTTP login success response. No Socket.IO identity check is needed.
 */
export async function completeServiceProvisioning(
  db: DatabaseSync,
  key: Buffer,
  worldId: string,
  foundryUserId: string,
  verify: VerifyFoundryServiceAccount,
  now = Date.now()
): Promise<"created" | "already-provisioned"> {
  if (typeof worldId !== "string" || !worldId || worldId.length > 128 ||
      typeof foundryUserId !== "string" || !foundryUserId || foundryUserId.length > 128 ||
      typeof verify !== "function" || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid provisioning completion");
  }
  if (key.length !== 32) throw new Error("Invalid credential encryption key");
  const existing = getStoredServiceCredential(db, worldId);
  if (existing) {
    if (existing.foundryUserId !== foundryUserId) throw new Error("Service account already provisioned");
    return "already-provisioned";
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const pending = getPendingServiceProvisioning(db, worldId);
    if (!pending) throw new Error("No pending service account provisioning");
    if (pending.foundryUserId && pending.foundryUserId !== foundryUserId) {
      throw new Error("Provisioning already claimed by another Foundry account");
    }
    db.prepare("UPDATE service_provisioning SET foundry_user_id = ? WHERE world_id = ?")
      .run(foundryUserId, worldId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const pending = getPendingServiceProvisioning(db, worldId);
  if (!pending || pending.foundryUserId !== foundryUserId) throw new Error("Provisioning state changed");
  const password = openServiceCredential(pending.encryptedPassword, key);
  if (!(await verify({ worldId, foundryUserId, password }))) {
    throw new Error("Foundry service account authentication verification failed");
  }
  const encrypted = sealServiceCredential(password, key);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getPendingServiceProvisioning(db, worldId);
    if (!current || current.foundryUserId !== foundryUserId ||
        current.encryptedPassword !== pending.encryptedPassword) {
      throw new Error("Provisioning state changed");
    }
    if (getStoredServiceCredential(db, worldId)) throw new Error("Service account already provisioned");
    db.prepare("INSERT INTO service_credentials(world_id, foundry_user_id, encrypted_password, updated_at) VALUES (?, ?, ?, ?)")
      .run(worldId, foundryUserId, encrypted, now);
    db.prepare("DELETE FROM service_provisioning WHERE world_id = ?").run(worldId);
    db.exec("COMMIT");
    return "created";
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
