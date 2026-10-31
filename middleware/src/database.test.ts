import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  openDatabase, registerDiscordIdentity, registerFoundryAccount, reconcileFoundryAccounts,
  createAccountMapping, getAccountMapping, getMappingByFoundryAccount,
  removeAccountMapping, createSession, getActiveSession, touchSession,
  revokeSession, purgeExpiredSessions, observeFoundrySession,
  claimInitialAdministrator, isAdministratorBootstrapComplete, isMillwrightAdministrator, getFoundryServerSettings, setFoundryAdminCredential, rememberActiveFoundryWorld
} from "./database.js";

test("explicit mappings are unique per world and persist across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "millwright-db-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path);
  try {
    registerDiscordIdentity(db, "267329046881370112");
    registerDiscordIdentity(db, "267329046881370112");
    registerDiscordIdentity(db, "111111111111111111");
    registerFoundryAccount(db, "world-a", "foundry-a");
    registerFoundryAccount(db, "world-a", "foundry-b");
    registerFoundryAccount(db, "world-b", "foundry-a");
    createAccountMapping(db, {
      worldId: "world-a", foundryUserId: "foundry-a",
      discordUserId: "267329046881370112"
    });
    assert.deepEqual({ ...getAccountMapping(db, "world-a", "267329046881370112") }, {
      worldId: "world-a", foundryUserId: "foundry-a",
      discordUserId: "267329046881370112"
    });
    assert.throws(() => createAccountMapping(db, {
      worldId: "world-a", foundryUserId: "foundry-b",
      discordUserId: "267329046881370112"
    }));
    assert.throws(() => createAccountMapping(db, {
      worldId: "world-a", foundryUserId: "foundry-a",
      discordUserId: "111111111111111111"
    }));
    createAccountMapping(db, {
      worldId: "world-b", foundryUserId: "foundry-a",
      discordUserId: "267329046881370112"
    });
    assert.equal(getMappingByFoundryAccount(db, "world-b", "foundry-a")?.discordUserId,
      "267329046881370112");
    db.close();
    db = openDatabase(path);
    assert.equal(getAccountMapping(db, "world-a", "267329046881370112")?.foundryUserId,
      "foundry-a");
    assert.equal(removeAccountMapping(db, "world-a", "foundry-a"), true);
    assert.equal(removeAccountMapping(db, "world-a", "foundry-a"), false);
    assert.equal(getAccountMapping(db, "world-a", "267329046881370112"), null);
    assert.equal(getAccountMapping(db, "world-b", "267329046881370112")?.foundryUserId,
      "foundry-a");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM discord_identities").get() as
      { count: number }).count, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapping requires registered identities and accounts", () => {
  const db = openDatabase(":memory:");
  try {
    assert.throws(() => registerDiscordIdentity(db, "not-a-discord-id"));
    assert.throws(() => registerFoundryAccount(db, "", "foundry-a"));
    assert.throws(() => createAccountMapping(db, {
      worldId: "missing", foundryUserId: "missing",
      discordUserId: "267329046881370112"
    }));
  } finally {
    db.close();
  }
});

test("sessions bind to Discord identity, persist, expire and revoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "millwright-session-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path);
  const discordId = "267329046881370112";
  try {
    assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 10);
    assert.throws(() => createSession(db, "invalid", 1000, 1000));
    assert.throws(() => createSession(db, discordId, 0, 1000));
    assert.throws(() => createSession(db, discordId, 1000, 1000)); // requires verified identity
    registerDiscordIdentity(db, discordId);
    const first = createSession(db, discordId, 1000, 1000);
    const second = createSession(db, discordId, 2000, 1000);
    assert.match(first.sessionId, /^[0-9a-f]{64}$/);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(getActiveSession(db, first.sessionId, 1500)?.discordUserId, discordId);
    assert.equal(touchSession(db, first.sessionId, 1600), true);
    assert.equal(getActiveSession(db, first.sessionId, 1600)?.lastSeenAt, 1600);
    assert.equal(touchSession(db, first.sessionId, 1500), false);
    assert.equal(getActiveSession(db, first.sessionId, 2000), null);
    assert.equal(touchSession(db, first.sessionId, 2000), false);
    assert.equal(revokeSession(db, second.sessionId, 1700), true);
    assert.equal(revokeSession(db, second.sessionId, 1800), false);
    assert.equal(getActiveSession(db, second.sessionId, 1800), null);
    db.close();
    db = openDatabase(path);
    assert.equal(getActiveSession(db, first.sessionId, 1500)?.discordUserId, discordId);
    assert.equal(getActiveSession(db, second.sessionId, 1500), null);
    assert.equal(purgeExpiredSessions(db, 2000), 1);
    assert.equal(purgeExpiredSessions(db, 3000), 1);
    assert.equal(purgeExpiredSessions(db, 3000), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v1 database migrates through v10 without altering account mappings", () => {
  const db = openDatabase(":memory:");
  try {
    registerDiscordIdentity(db, "267329046881370112");
    registerFoundryAccount(db, "world-a", "user-a");
    createAccountMapping(db, {
      worldId: "world-a", foundryUserId: "user-a",
      discordUserId: "267329046881370112"
    });
    // Simulate a database created by the previous version.
    db.exec("DROP TABLE foundry_server_settings; DROP TABLE managed_foundry_sessions; DROP TABLE service_provisioning; DROP TABLE service_credentials; DROP TABLE administrator_bootstrap; DROP TABLE administrators; DROP TABLE foundry_sessions; DROP TABLE sessions; ALTER TABLE discord_identities DROP COLUMN username; ALTER TABLE discord_identities DROP COLUMN display_name; ALTER TABLE discord_identities DROP COLUMN name_synced_at; DELETE FROM schema_migrations WHERE version >= 2");
    // In-memory databases cannot be reopened; use a file-backed database below instead.
    assert.equal(getAccountMapping(db, "world-a", "267329046881370112")?.foundryUserId, "user-a");
  } finally {
    db.close();
  }
  const dir = mkdtempSync(join(tmpdir(), "millwright-v1-"));
  const path = join(dir, "legacy.sqlite");
  let legacy = openDatabase(path);
  try {
    registerDiscordIdentity(legacy, "267329046881370112");
    registerFoundryAccount(legacy, "world-a", "user-a");
    createAccountMapping(legacy, {
      worldId: "world-a", foundryUserId: "user-a",
      discordUserId: "267329046881370112"
    });
    legacy.exec("DROP TABLE foundry_server_settings; DROP TABLE managed_foundry_sessions; DROP TABLE service_provisioning; DROP TABLE service_credentials; DROP TABLE administrator_bootstrap; DROP TABLE administrators; DROP TABLE foundry_sessions; DROP TABLE sessions; ALTER TABLE discord_identities DROP COLUMN username; ALTER TABLE discord_identities DROP COLUMN display_name; ALTER TABLE discord_identities DROP COLUMN name_synced_at; DELETE FROM schema_migrations WHERE version >= 2");
    legacy.close();
    legacy = openDatabase(path);
    assert.equal((legacy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 10);
    assert.equal(getAccountMapping(legacy, "world-a", "267329046881370112")?.foundryUserId, "user-a");
    assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get());
  } finally {
    if (legacy.isOpen) legacy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 migrates through v10 preserving existing sessions and mappings", () => {
  const dir = mkdtempSync(join(tmpdir(), "millwright-v2-"));
  const path = join(dir, "legacy.sqlite");
  let db = openDatabase(path);
  const discordId = "267329046881370112";
  try {
    registerDiscordIdentity(db, discordId);
    registerFoundryAccount(db, "world-a", "foundry-a");
    createAccountMapping(db, { worldId: "world-a", foundryUserId: "foundry-a", discordUserId: discordId });
    const session = createSession(db, discordId, 100000, 1000);
    db.exec("DROP TABLE foundry_server_settings; DROP TABLE managed_foundry_sessions; DROP TABLE service_provisioning; DROP TABLE service_credentials; DROP TABLE administrator_bootstrap; DROP TABLE administrators; DROP TABLE foundry_sessions; ALTER TABLE discord_identities DROP COLUMN username; ALTER TABLE discord_identities DROP COLUMN display_name; ALTER TABLE discord_identities DROP COLUMN name_synced_at; DELETE FROM schema_migrations WHERE version >= 3");
    db.close();
    db = openDatabase(path);
    assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 10);
    assert.equal(getAccountMapping(db, "world-a", discordId)?.foundryUserId, "foundry-a");
    assert.equal(getActiveSession(db, session.sessionId, 1500)?.discordUserId, discordId);
    const observed = observeFoundrySession(db, {
      worldId: "world-a", millwrightSessionId: session.sessionId,
      activeFoundryUserId: "foundry-a", activeFoundryUserRole: 4,
    }, 1500);
    assert.equal(observed.activeFoundryUserId, "foundry-a");
    assert.equal(observeFoundrySession(db, {
      worldId: "world-b", millwrightSessionId: session.sessionId,
      activeFoundryUserId: null, activeFoundryUserRole: null,
    }, 1600).worldId, "world-b");
    const other = createSession(db, discordId, 100000, 1000);
    observeFoundrySession(db, {
      worldId: "world-b", millwrightSessionId: other.sessionId,
      activeFoundryUserId: "foundry-a", activeFoundryUserRole: 4,
    }, 1700);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM foundry_sessions").get() as { n: number }).n, 2);
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("administrator bootstrap is atomic, one-time, and persists across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "millwright-admin-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path);
  const first = "267329046881370112";
  const second = "111111111111111111";
  try {
    assert.equal(isAdministratorBootstrapComplete(db), false);
    assert.equal(isMillwrightAdministrator(db, first), false);
    assert.throws(() => claimInitialAdministrator(db, "invalid"));
    assert.throws(() => claimInitialAdministrator(db, first)); // identity must be verified
    assert.equal(isAdministratorBootstrapComplete(db), false);
    registerDiscordIdentity(db, first);
    registerDiscordIdentity(db, second);
    assert.equal(claimInitialAdministrator(db, first, 12345), true);
    assert.equal(isAdministratorBootstrapComplete(db), true);
    assert.equal(isMillwrightAdministrator(db, first), true);
    assert.equal(isMillwrightAdministrator(db, second), false);
    assert.equal(claimInitialAdministrator(db, second, 12346), false);
    db.close();
    db = openDatabase(path);
    assert.equal(isAdministratorBootstrapComplete(db), true);
    assert.equal(isMillwrightAdministrator(db, first), true);
    assert.equal(claimInitialAdministrator(db, second, 12347), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM administrators").get() as { n: number }).n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation removes stale mappings only in the selected world", () => {
  const db = openDatabase(":memory:");
  try {
    const id = "267329046881370112";
    registerDiscordIdentity(db, id);
    assert.deepEqual(reconcileFoundryAccounts(db, "a", ["one", "two"]), { registered: 2, removed: 0 });
    reconcileFoundryAccounts(db, "b", ["one"]);
    createAccountMapping(db, { worldId: "a", foundryUserId: "one", discordUserId: id });
    createAccountMapping(db, { worldId: "b", foundryUserId: "one", discordUserId: id });
    assert.deepEqual(reconcileFoundryAccounts(db, "a", ["two"]), { registered: 1, removed: 1 });
    assert.equal(getAccountMapping(db, "a", id), null);
    assert.equal(getAccountMapping(db, "b", id)?.foundryUserId, "one");
    assert.throws(() => reconcileFoundryAccounts(db, "a", ["two", "two"]));
  } finally {
    db.close();
  }
});

test("Foundry integration settings persist without exposing credential values", () => {
  const dir = mkdtempSync(join(tmpdir(), "millwright-foundry-settings-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path);
  try {
    assert.deepEqual({ ...getFoundryServerSettings(db) }, { encryptedPassword: null, lastWorldId: null });
    setFoundryAdminCredential(db, "encrypted-example");
    rememberActiveFoundryWorld(db, "test-world");
    db.close();
    db = openDatabase(path);
    assert.deepEqual({ ...getFoundryServerSettings(db) }, {
      encryptedPassword: "encrypted-example", lastWorldId: "test-world"
    });
    setFoundryAdminCredential(db, null);
    assert.deepEqual({ ...getFoundryServerSettings(db) }, {
      encryptedPassword: null, lastWorldId: "test-world"
    });
    assert.throws(() => rememberActiveFoundryWorld(db, ""));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
