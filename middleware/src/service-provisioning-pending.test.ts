import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, storeServiceCredential } from "./database.js";
import { sealServiceCredential } from "./service-credentials.js";
import { getPendingServiceProvisioning, prepareServiceProvisioning } from "./service-provisioning-pending.js";

test("pending provisioning is encrypted, idempotent, world-isolated and restart-safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "millwright-pending-"));
  const path = join(dir, "test.sqlite");
  const key = randomBytes(32);
  let db = openDatabase(path);
  try {
    const first = prepareServiceProvisioning(db, key, "world-a", 100);
    assert.equal(first.resumed, false);
    assert.ok(first.password.length >= 64);
    const pending = getPendingServiceProvisioning(db, "world-a")!;
    assert.equal(pending.createdAt, 100);
    assert.equal(pending.foundryUserId, null);
    assert.ok(!pending.encryptedPassword.includes(first.password));
    assert.deepEqual(prepareServiceProvisioning(db, key, "world-a", 200), { password: first.password, resumed: true });
    const second = prepareServiceProvisioning(db, key, "world-b", 300);
    assert.notEqual(second.password, first.password);
    db.close();
    db = openDatabase(path);
    assert.deepEqual(prepareServiceProvisioning(db, key, "world-a", 400), { password: first.password, resumed: true });
    assert.throws(() => prepareServiceProvisioning(db, randomBytes(32), "world-a"));
    storeServiceCredential(db, "world-a", "owned-user", sealServiceCredential(first.password, key));
    assert.throws(() => prepareServiceProvisioning(db, key, "world-a"));
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid pending provisioning requests do not create records", () => {
  const db = openDatabase(":memory:");
  try {
    assert.throws(() => prepareServiceProvisioning(db, randomBytes(32), ""));
    assert.throws(() => prepareServiceProvisioning(db, Buffer.alloc(2), "world"));
    assert.throws(() => prepareServiceProvisioning(db, randomBytes(32), "world", -1));
    assert.equal(getPendingServiceProvisioning(db, "world"), null);
  } finally { db.close(); }
});
