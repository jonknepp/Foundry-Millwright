import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { openDatabase, getStoredServiceCredential } from "./database.js";
import { openServiceCredential } from "./service-credentials.js";
import { prepareServiceProvisioning } from "./service-provisioning-pending.js";
import { completeServiceProvisioning } from "./service-provisioning-complete.js";

test("completion requires verification before activating encrypted credentials", async () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  try {
    const { password } = prepareServiceProvisioning(db, key, "world-a");
    await assert.rejects(
      completeServiceProvisioning(db, key, "world-a", "service-user", async () => false),
      /verification failed/
    );
    assert.equal(getStoredServiceCredential(db, "world-a"), null);
    assert.equal((await completeServiceProvisioning(db, key, "world-a", "service-user", async input => {
      assert.deepEqual(input, { worldId: "world-a", foundryUserId: "service-user", password });
      return true;
    })), "created");
    const stored = getStoredServiceCredential(db, "world-a")!;
    assert.equal(stored.foundryUserId, "service-user");
    assert.notEqual(stored.encryptedPassword, password);
    assert.equal(openServiceCredential(stored.encryptedPassword, key), password);
    assert.equal(await completeServiceProvisioning(db, key, "world-a", "service-user", async () => {
      throw new Error("Should not reverify completed account");
    }), "already-provisioned");
    await assert.rejects(
      completeServiceProvisioning(db, key, "world-a", "other-user", async () => true),
      /already provisioned/
    );
  } finally { db.close(); }
});

test("completion rejects mismatched account claims and missing pending records", async () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  try {
    await assert.rejects(
      completeServiceProvisioning(db, key, "missing", "service-user", async () => true),
      /No pending/
    );
    prepareServiceProvisioning(db, key, "world-a");
    await assert.rejects(
      completeServiceProvisioning(db, key, "world-a", "first-user", async () => false),
      /verification failed/
    );
    await assert.rejects(
      completeServiceProvisioning(db, key, "world-a", "second-user", async () => true),
      /claimed/
    );
    assert.equal(getStoredServiceCredential(db, "world-a"), null);
  } finally { db.close(); }
});
