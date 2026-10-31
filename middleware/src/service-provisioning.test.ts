import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { openDatabase, getStoredServiceCredential } from "./database.js";
import { commitServiceAccountProvisioning } from "./service-provisioning.js";
import { openServiceCredential } from "./service-credentials.js";

test("provisioning stores encrypted credentials and is idempotent", () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  const password = "generated-password-1234567890";
  try {
    assert.equal(commitServiceAccountProvisioning(db, key, "world-a", "owned-id", password, 100), "created");
    const first = getStoredServiceCredential(db, "world-a")!;
    assert.equal(openServiceCredential(first.encryptedPassword, key), password);
    assert.equal(first.updatedAt, 100);
    assert.equal(commitServiceAccountProvisioning(db, key, "world-a", "owned-id", password, 200), "already-provisioned");
    assert.deepEqual(getStoredServiceCredential(db, "world-a"), first);
    assert.throws(() => commitServiceAccountProvisioning(db, key, "world-a", "other-id", password));
    assert.throws(() => commitServiceAccountProvisioning(db, key, "world-a", "owned-id", "different-password-123456789"));
    assert.deepEqual(getStoredServiceCredential(db, "world-a"), first);
    assert.equal(commitServiceAccountProvisioning(db, key, "world-b", "other-id", password), "created");
  } finally { db.close(); }
});

test("invalid provisioning input cannot create credentials", () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  try {
    assert.throws(() => commitServiceAccountProvisioning(db, key, "", "user", "generated-password-1234567890"));
    assert.throws(() => commitServiceAccountProvisioning(db, key, "world", "user", "short"));
    assert.throws(() => commitServiceAccountProvisioning(db, Buffer.alloc(2), "world", "user", "generated-password-1234567890"));
    assert.equal(getStoredServiceCredential(db, "world"), null);
  } finally { db.close(); }
});
