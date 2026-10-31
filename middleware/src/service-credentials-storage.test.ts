import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { openDatabase, getStoredServiceCredential, storeServiceCredential } from "./database.js";
import { openServiceCredential, sealServiceCredential } from "./service-credentials.js";

test("service credentials persist encrypted and remain world-isolated", () => {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  try {
    const encrypted = sealServiceCredential("private-password", key);
    storeServiceCredential(db, "world-one", "service-user", encrypted, 123);
    const stored = getStoredServiceCredential(db, "world-one");
    assert.equal(stored?.foundryUserId, "service-user");
    assert.equal(stored?.updatedAt, 123);
    assert.equal(stored?.encryptedPassword, encrypted);
    assert.ok(!stored?.encryptedPassword.includes("private-password"));
    assert.equal(openServiceCredential(stored!.encryptedPassword, key), "private-password");
    assert.equal(getStoredServiceCredential(db, "world-two"), null);
    const rotated = sealServiceCredential("rotated-password", key);
    storeServiceCredential(db, "world-one", "service-user", rotated, 124);
    assert.equal(openServiceCredential(getStoredServiceCredential(db, "world-one")!.encryptedPassword, key), "rotated-password");
    assert.throws(() => storeServiceCredential(db, "world-one", "service-user", "plaintext"));
  } finally { db.close(); }
});
