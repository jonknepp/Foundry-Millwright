import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AccountMapping = {
  worldId: string;
  foundryUserId: string;
  discordUserId: string;
};

export function openDatabase(path = "/var/lib/millwright/millwright.sqlite"): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if ((version?.version ?? 0) > 14) throw new Error("Database schema is newer than this middleware");
    if ((version?.version ?? 0) === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE discord_identities (
            discord_user_id TEXT PRIMARY KEY NOT NULL
              CHECK(length(discord_user_id) BETWEEN 17 AND 20
                AND discord_user_id NOT GLOB '*[^0-9]*'),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE foundry_accounts (
            world_id TEXT NOT NULL,
            foundry_user_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (world_id, foundry_user_id),
            CHECK(length(world_id) > 0),
            CHECK(length(foundry_user_id) > 0)
          );
          CREATE TABLE account_mappings (
            world_id TEXT NOT NULL,
            foundry_user_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (world_id, foundry_user_id),
            UNIQUE (world_id, discord_user_id),
            FOREIGN KEY (world_id, foundry_user_id)
              REFERENCES foundry_accounts(world_id, foundry_user_id) ON DELETE CASCADE,
            FOREIGN KEY (discord_user_id)
              REFERENCES discord_identities(discord_user_id) ON DELETE RESTRICT
          );
          INSERT INTO schema_migrations(version) VALUES (1);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 2) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY NOT NULL
              CHECK(length(session_id) = 64 AND session_id NOT GLOB '*[^0-9a-f]*'),
            discord_user_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER,
            CHECK(expires_at > created_at),
            CHECK(last_seen_at >= created_at),
            FOREIGN KEY (discord_user_id)
              REFERENCES discord_identities(discord_user_id) ON DELETE RESTRICT
          );
          CREATE INDEX sessions_discord_user_idx ON sessions(discord_user_id);
          CREATE INDEX sessions_expires_idx ON sessions(expires_at);
          INSERT INTO schema_migrations(version) VALUES (2);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 3) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE foundry_sessions (
            world_id TEXT NOT NULL,
            foundry_session_hash TEXT NOT NULL,
            millwright_session_id TEXT NOT NULL,
            active_foundry_user_id TEXT,
            active_foundry_user_role INTEGER,
            observed_at INTEGER NOT NULL,
            PRIMARY KEY (world_id, foundry_session_hash),
            FOREIGN KEY (millwright_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          );
          CREATE INDEX foundry_sessions_millwright_idx ON foundry_sessions(millwright_session_id);
          INSERT INTO schema_migrations(version) VALUES (3);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 4) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Observations are ephemeral. Preserve identities, mappings and sessions.
        db.exec(`
          DROP TABLE foundry_sessions;
          CREATE TABLE foundry_sessions (
            millwright_session_id TEXT PRIMARY KEY NOT NULL,
            world_id TEXT NOT NULL,
            active_foundry_user_id TEXT,
            active_foundry_user_role INTEGER,
            observed_at INTEGER NOT NULL,
            FOREIGN KEY (millwright_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          );
          INSERT INTO schema_migrations(version) VALUES (4);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 5) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE administrators (
            discord_user_id TEXT PRIMARY KEY NOT NULL,
            granted_at INTEGER NOT NULL,
            granted_by TEXT NOT NULL,
            FOREIGN KEY (discord_user_id)
              REFERENCES discord_identities(discord_user_id) ON DELETE RESTRICT
          );
          CREATE TABLE administrator_bootstrap (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            completed_at INTEGER,
            completed_by TEXT,
            CHECK ((completed_at IS NULL) = (completed_by IS NULL)),
            FOREIGN KEY (completed_by)
              REFERENCES discord_identities(discord_user_id) ON DELETE RESTRICT
          );
          INSERT INTO administrator_bootstrap(id) VALUES (1);
          INSERT INTO schema_migrations(version) VALUES (5);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 6) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE service_credentials (
            world_id TEXT PRIMARY KEY NOT NULL CHECK(length(world_id) BETWEEN 1 AND 128),
            foundry_user_id TEXT NOT NULL CHECK(length(foundry_user_id) BETWEEN 1 AND 128),
            encrypted_password TEXT NOT NULL CHECK(length(encrypted_password) > 0),
            updated_at INTEGER NOT NULL
          );
          INSERT INTO schema_migrations(version) VALUES (6);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 7) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE service_provisioning (world_id TEXT PRIMARY KEY NOT NULL, encrypted_password TEXT NOT NULL, created_at INTEGER NOT NULL, foundry_user_id TEXT); INSERT INTO schema_migrations(version) VALUES (7);`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 8) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE managed_foundry_sessions (
            millwright_session_id TEXT PRIMARY KEY NOT NULL,
            world_id TEXT NOT NULL,
            foundry_user_id TEXT NOT NULL,
            encrypted_cookie TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (millwright_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          );
          INSERT INTO schema_migrations(version) VALUES (8);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 9) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE discord_identities ADD COLUMN username TEXT");
        db.exec("ALTER TABLE discord_identities ADD COLUMN display_name TEXT");
        db.exec("ALTER TABLE discord_identities ADD COLUMN name_synced_at INTEGER");
        db.exec("INSERT INTO schema_migrations(version) VALUES (9)");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((version?.version ?? 0) < 10) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE foundry_server_settings (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted_admin_password TEXT, last_world_id TEXT)");
        db.exec("INSERT INTO foundry_server_settings(id) VALUES (1)");
        db.exec("INSERT INTO schema_migrations(version) VALUES (10)");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if ((version?.version ?? 0) < 11) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE foundry_server_settings ADD COLUMN admin_username TEXT");
        db.exec("INSERT INTO schema_migrations(version) VALUES (11)");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if ((version?.version ?? 0) < 12) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE foundry_config_pending (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          restart_pending INTEGER NOT NULL DEFAULT 0,
          restart_requested_at INTEGER,
          restart_confirmed_at INTEGER,
          pending_password TEXT,
          pending_username TEXT,
          pending_kind TEXT NOT NULL DEFAULT 'none',
          verification TEXT NOT NULL DEFAULT 'none',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO foundry_config_pending(id) VALUES (1);
        INSERT INTO schema_migrations(version) VALUES (12);`);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if ((version?.version ?? 0) < 13) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE foundry_config_pending ADD COLUMN pending_change_keys TEXT NOT NULL DEFAULT '[]'");
        db.exec("INSERT INTO schema_migrations(version) VALUES (13)");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if ((version?.version ?? 0) < 14) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE foundry_accounts ADD COLUMN player_name TEXT");
        db.exec("ALTER TABLE foundry_accounts ADD COLUMN player_role INTEGER");
        db.exec("INSERT INTO schema_migrations(version) VALUES (14)");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getAccountMapping(
  db: DatabaseSync,
  worldId: string,
  discordUserId: string
): AccountMapping | null {
  const row = db.prepare(`
    SELECT world_id AS worldId, foundry_user_id AS foundryUserId,
           discord_user_id AS discordUserId
    FROM account_mappings WHERE world_id = ? AND discord_user_id = ?
  `).get(worldId, discordUserId);
  return (row as AccountMapping | undefined) ?? null;
}

export function registerDiscordIdentity(db: DatabaseSync, discordUserId: string): void {
  if (!/^[0-9]{17,20}$/.test(discordUserId)) throw new Error("Invalid Discord user ID");
  db.prepare("INSERT OR IGNORE INTO discord_identities(discord_user_id) VALUES (?)").run(discordUserId);
}

export function updateDiscordIdentityName(db: DatabaseSync, userId: string, username: string, displayName: string): void {
  if (!/^[0-9]{17,20}$/.test(userId) || !username || !displayName ||
      username.length > 128 || displayName.length > 128) throw new Error("Invalid Discord identity name");
  registerDiscordIdentity(db, userId);
  db.prepare("UPDATE discord_identities SET username = ?, display_name = ?, name_synced_at = ? WHERE discord_user_id = ?")
    .run(username, displayName, Date.now(), userId);
}

export function registerFoundryAccount(db: DatabaseSync, worldId: string, foundryUserId: string): void {
  if (!worldId || !foundryUserId) throw new Error("World and Foundry user IDs are required");
  db.prepare("INSERT OR IGNORE INTO foundry_accounts(world_id, foundry_user_id) VALUES (?, ?)").run(worldId, foundryUserId);
}

export function createAccountMapping(db: DatabaseSync, mapping: AccountMapping): void {
  db.prepare(`
    INSERT INTO account_mappings(world_id, foundry_user_id, discord_user_id)
    VALUES (?, ?, ?)
  `).run(mapping.worldId, mapping.foundryUserId, mapping.discordUserId);
}

/** Atomically reassigns an existing Foundry account without displacing another mapping. */
export function updateAccountMapping(
  db: DatabaseSync, worldId: string, foundryUserId: string, discordUserId: string
): "updated" | "unchanged" | "missing" | "conflict" {
  if (!worldId || worldId.length > 128 || !foundryUserId || foundryUserId.length > 128 ||
      !/^[0-9]{17,20}$/.test(discordUserId)) throw new Error("Invalid mapping identifiers");
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = getMappingByFoundryAccount(db, worldId, foundryUserId);
    if (!existing) { db.exec("COMMIT"); return "missing"; }
    if (existing.discordUserId === discordUserId) { db.exec("COMMIT"); return "unchanged"; }
    if (getAccountMapping(db, worldId, discordUserId)) {
      db.exec("COMMIT"); return "conflict";
    }
    registerDiscordIdentity(db, discordUserId);
    db.prepare(`UPDATE account_mappings SET discord_user_id = ?
      WHERE world_id = ? AND foundry_user_id = ?`).run(discordUserId, worldId, foundryUserId);
    db.exec("COMMIT");
    return "updated";
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getMappingByFoundryAccount(
  db: DatabaseSync, worldId: string, foundryUserId: string
): AccountMapping | null {
  const row = db.prepare(`
    SELECT world_id AS worldId, foundry_user_id AS foundryUserId,
           discord_user_id AS discordUserId
    FROM account_mappings WHERE world_id = ? AND foundry_user_id = ?
  `).get(worldId, foundryUserId);
  return (row as AccountMapping | undefined) ?? null;
}

export function removeAccountMapping(
  db: DatabaseSync, worldId: string, foundryUserId: string
): boolean {
  const result = db.prepare(
    "DELETE FROM account_mappings WHERE world_id = ? AND foundry_user_id = ?"
  ).run(worldId, foundryUserId);
  return result.changes === 1;
}

export type MillwrightSession = {
  sessionId: string;
  discordUserId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

function readSession(db: DatabaseSync, sessionId: string): MillwrightSession | null {
  const row = db.prepare(`
    SELECT session_id AS sessionId, discord_user_id AS discordUserId,
           created_at AS createdAt, last_seen_at AS lastSeenAt,
           expires_at AS expiresAt, revoked_at AS revokedAt
    FROM sessions WHERE session_id = ?
  `).get(sessionId);
  return (row as MillwrightSession | undefined) ?? null;
}

/** Creates an opaque session ID; the caller must have already authenticated the Discord identity. */
export function createSession(
  db: DatabaseSync, discordUserId: string, ttlMs: number,
  now = Date.now()
): MillwrightSession {
  if (!/^[0-9]{17,20}$/.test(discordUserId)) throw new Error("Invalid Discord user ID");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(now + ttlMs)) throw new Error("Invalid session lifetime");
  const sessionId = randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO sessions(session_id, discord_user_id, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, discordUserId, now, now, now + ttlMs);
  return readSession(db, sessionId)!;
}

/** Returns only sessions that have not expired or been revoked. */
export function getActiveSession(
  db: DatabaseSync, sessionId: string, now = Date.now()
): MillwrightSession | null {
  const session = readSession(db, sessionId);
  return session && session.revokedAt === null && session.expiresAt > now
    ? session : null;
}

/** Extends activity timestamp, without extending the session expiration. */
export function touchSession(
  db: DatabaseSync, sessionId: string, now = Date.now()
): boolean {
  const result = db.prepare(`
    UPDATE sessions SET last_seen_at = ?
    WHERE session_id = ? AND revoked_at IS NULL
      AND expires_at > ? AND last_seen_at <= ?
  `).run(now, sessionId, now, now);
  return result.changes === 1;
}

export function revokeSession(
  db: DatabaseSync, sessionId: string, now = Date.now()
): boolean {
  const result = db.prepare(`
    UPDATE sessions SET revoked_at = ?
    WHERE session_id = ? AND revoked_at IS NULL
  `).run(now, sessionId);
  return result.changes === 1;
}

/** Administrator inventory uses non-secret SHA-256 handles, never bearer session IDs. */
export function listActiveSessions(db: DatabaseSync, now = Date.now()) {
  const rows = db.prepare(`
    SELECT s.session_id AS sessionId, s.discord_user_id AS discordUserId,
           s.created_at AS createdAt, s.last_seen_at AS lastSeenAt,
           d.username AS discordUsername, d.display_name AS discordDisplayName,
           d.name_synced_at AS discordNameSyncedAt,
           s.expires_at AS expiresAt,
           f.world_id AS observedWorldId,
           f.active_foundry_user_id AS observedFoundryUserId,
           f.active_foundry_user_role AS observedFoundryUserRole,
           f.observed_at AS observedAt
    FROM sessions s JOIN discord_identities d ON d.discord_user_id = s.discord_user_id
    LEFT JOIN foundry_sessions f
      ON f.millwright_session_id = s.session_id
    WHERE s.revoked_at IS NULL AND s.expires_at > ?
    ORDER BY s.last_seen_at DESC
  `).all(now) as Array<{
    sessionId: string;
    discordUserId: string;
    discordUsername: string | null;
    discordDisplayName: string | null;
    discordNameSyncedAt: number | null;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    observedWorldId: string | null;
    observedFoundryUserId: string | null;
    observedFoundryUserRole: number | null;
    observedAt: number | null;
  }>;
  return rows.map(({ sessionId, ...fields }) => ({
    sessionHandle: createHash("sha256").update(sessionId).digest("hex"), ...fields
  }));
}

/** Revoke by a non-secret handle; the actual bearer credential is never exposed. */
export function revokeSessionByHandle(db: DatabaseSync, handle: string, now = Date.now()): boolean {
  if (!/^[a-f0-9]{64}$/.test(handle)) return false;
  const rows = db.prepare("SELECT session_id AS sessionId FROM sessions WHERE revoked_at IS NULL AND expires_at > ?")
    .all(now) as Array<{ sessionId: string }>;
  const matching = rows.find(row => createHash("sha256").update(row.sessionId).digest("hex") === handle);
  return matching ? revokeSession(db, matching.sessionId, now) : false;
}

/** Deletes expired sessions, including revoked sessions once their expiry has passed. */
export function purgeExpiredSessions(db: DatabaseSync, now = Date.now()): number {
  return Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes);
}

/** Remove untracked authentication-only sessions, preserving the caller and managed Foundry logins. */
export function purgeUnmanagedSessions(db: DatabaseSync, preserveSessionId: string): number {
  return Number(db.prepare(`
    DELETE FROM sessions
    WHERE session_id <> ?
      AND NOT EXISTS (
        SELECT 1 FROM managed_foundry_sessions m
        WHERE m.millwright_session_id = sessions.session_id
      )
  `).run(preserveSessionId).changes);
}

export type FoundrySessionObservation = {
  millwrightSessionId: string;
  worldId: string;
  activeFoundryUserId: string | null;
  activeFoundryUserRole: number | null;
  observedAt: number;
};

/** Client-reported telemetry; never use as proof of Foundry authentication or role. */
export function observeFoundrySession(
  db: DatabaseSync,
  input: {
    worldId: string; millwrightSessionId: string;
    activeFoundryUserId: string | null; activeFoundryUserRole: number | null;
  },
  now = Date.now()
): FoundrySessionObservation {
  if (!input.worldId || input.worldId.length > 128 ||
      (input.activeFoundryUserId !== null && (!input.activeFoundryUserId || input.activeFoundryUserId.length > 128)) ||
      (input.activeFoundryUserRole !== null && (!Number.isInteger(input.activeFoundryUserRole) ||
        input.activeFoundryUserRole < 0 || input.activeFoundryUserRole > 4))) {
    throw new Error("Invalid Foundry session observation");
  }
  db.prepare(`
    INSERT INTO foundry_sessions
      (millwright_session_id, world_id, active_foundry_user_id, active_foundry_user_role, observed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(millwright_session_id) DO UPDATE SET
      world_id = excluded.world_id,
      active_foundry_user_id = excluded.active_foundry_user_id,
      active_foundry_user_role = excluded.active_foundry_user_role,
      observed_at = excluded.observed_at
  `).run(input.millwrightSessionId, input.worldId, input.activeFoundryUserId,
    input.activeFoundryUserRole, now);
  return { ...input, observedAt: now };
}


/** Application authorization is independent of Foundry GM/Administrator roles. */
export function isMillwrightAdministrator(db: DatabaseSync, discordUserId: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM administrators WHERE discord_user_id = ?"
  ).get(discordUserId);
}

export function isAdministratorBootstrapComplete(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT completed_at AS completedAt FROM administrator_bootstrap WHERE id = 1"
  ).get() as { completedAt: number | null } | undefined;
  if (!row) throw new Error("Administrator bootstrap state is missing");
  return row.completedAt !== null;
}

/**
 * Call only after validating the one-time host bootstrap challenge.
 * The claim and permanent bootstrap closure are a single transaction.
 */
export function claimInitialAdministrator(
  db: DatabaseSync, discordUserId: string, now = Date.now()
): boolean {
  if (!/^[0-9]{17,20}$/.test(discordUserId)) throw new Error("Invalid Discord user ID");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid timestamp");
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare(`
      UPDATE administrator_bootstrap
      SET completed_at = ?, completed_by = ?
      WHERE id = 1 AND completed_at IS NULL
    `).run(now, discordUserId);
    if (updated.changes !== 1) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(`
      INSERT INTO administrators(discord_user_id, granted_at, granted_by)
      VALUES (?, ?, 'bootstrap')
    `).run(discordUserId, now);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Server-owned mappings only; never infer authorization from Foundry client observations. */
export function getAccountMappingsForDiscordIdentity(
  db: DatabaseSync, discordUserId: string
): AccountMapping[] {
  return db.prepare(`
    SELECT world_id AS worldId, foundry_user_id AS foundryUserId,
           discord_user_id AS discordUserId
    FROM account_mappings WHERE discord_user_id = ?
    ORDER BY world_id
  `).all(discordUserId) as AccountMapping[];
}

/** Lists world-scoped associations for the administrator's linking interface. */
export function getAccountMappingsForWorld(db: DatabaseSync, worldId: string): AccountMapping[] {
  return db.prepare(`
    SELECT world_id AS worldId, foundry_user_id AS foundryUserId,
           discord_user_id AS discordUserId
    FROM account_mappings WHERE world_id = ?
    ORDER BY foundry_user_id
  `).all(worldId) as AccountMapping[];
}

/**
 * Replace the registered account inventory for one world from a trusted
 * server-side Foundry source. Do not expose this function to browser reports.
 * Removing an account cascades to its mapping, so stale users lose eligibility.
 */
export function reconcileFoundryAccounts(
  db: DatabaseSync, worldId: string, foundryUserIds: readonly string[]
): { registered: number; removed: number } {
  if (!worldId || worldId.length > 128) throw new Error("Invalid world ID");
  if (!Array.isArray(foundryUserIds) || foundryUserIds.length > 10000 ||
      foundryUserIds.some(id => typeof id !== "string" || !id || id.length > 128) ||
      new Set(foundryUserIds).size !== foundryUserIds.length) {
    throw new Error("Invalid Foundry account inventory");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO foundry_accounts(world_id, foundry_user_id) VALUES (?, ?)"
    );
    for (const id of foundryUserIds) insert.run(worldId, id);
    const existing = db.prepare(
      "SELECT foundry_user_id AS id FROM foundry_accounts WHERE world_id = ?"
    ).all(worldId) as { id: string }[];
    const allowed = new Set(foundryUserIds);
    const remove = db.prepare(
      "DELETE FROM foundry_accounts WHERE world_id = ? AND foundry_user_id = ?"
    );
    let removed = 0;
    for (const row of existing) {
      if (!allowed.has(row.id)) removed += Number(remove.run(worldId, row.id).changes);
    }
    db.exec("COMMIT");
    return { registered: foundryUserIds.length, removed };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Store trusted, synchronized Foundry player metadata without changing account mappings. */
export function saveFoundryPlayerMetadata(
  db: DatabaseSync, worldId: string,
  accounts: readonly { id: string; name: string; role: number }[]
): void {
  if (!worldId || accounts.some(a => !a.id || !a.name || a.name.length > 256 ||
    !Number.isInteger(a.role) || a.role < 0 || a.role > 4)) throw new Error("Invalid Foundry player metadata");
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE foundry_accounts SET player_name = ?, player_role = ? WHERE world_id = ? AND foundry_user_id = ?");
    for (const account of accounts) update.run(account.name, account.role, worldId, account.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export type StoredServiceCredential = {
  worldId: string;
  foundryUserId: string;
  encryptedPassword: string;
  updatedAt: number;
};

/** Persist only authenticated ciphertext; never store the service password in plaintext. */
export function storeServiceCredential(
  db: DatabaseSync, worldId: string, foundryUserId: string,
  encryptedPassword: string, now = Date.now()
): void {
  if (!worldId || worldId.length > 128 || !foundryUserId || foundryUserId.length > 128 ||
      !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(encryptedPassword) ||
      !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid service credential record");
  db.prepare(`
    INSERT INTO service_credentials(world_id, foundry_user_id, encrypted_password, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(world_id) DO UPDATE SET
      foundry_user_id = excluded.foundry_user_id,
      encrypted_password = excluded.encrypted_password,
      updated_at = excluded.updated_at
  `).run(worldId, foundryUserId, encryptedPassword, now);
}

export function getStoredServiceCredential(
  db: DatabaseSync, worldId: string
): StoredServiceCredential | null {
  const row = db.prepare(`
    SELECT world_id AS worldId, foundry_user_id AS foundryUserId,
           encrypted_password AS encryptedPassword, updated_at AS updatedAt
    FROM service_credentials WHERE world_id = ?
  `).get(worldId);
  return (row as StoredServiceCredential | undefined) ?? null;
}

/** Encrypted Foundry bearer cookies are never returned by inventory APIs. */
export function storeManagedFoundrySession(db: DatabaseSync, input: {
  millwrightSessionId: string; worldId: string; foundryUserId: string; encryptedCookie: string;
}, now = Date.now()): void {
  db.prepare(`INSERT INTO managed_foundry_sessions
    (millwright_session_id, world_id, foundry_user_id, encrypted_cookie, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(millwright_session_id) DO UPDATE SET
      world_id=excluded.world_id, foundry_user_id=excluded.foundry_user_id,
      encrypted_cookie=excluded.encrypted_cookie, created_at=excluded.created_at`)
    .run(input.millwrightSessionId, input.worldId, input.foundryUserId, input.encryptedCookie, now);
}

export function getManagedFoundrySessionByHandle(db: DatabaseSync, handle: string, now = Date.now()): {
  millwrightSessionId: string; encryptedCookie: string; worldId: string; foundryUserId: string;
} | null {
  if (!/^[a-f0-9]{64}$/.test(handle)) return null;
  const rows = db.prepare(`SELECT m.millwright_session_id AS millwrightSessionId,
    m.encrypted_cookie AS encryptedCookie, m.world_id AS worldId,
    m.foundry_user_id AS foundryUserId FROM managed_foundry_sessions m
    JOIN sessions s ON s.session_id=m.millwright_session_id
    WHERE s.revoked_at IS NULL AND s.expires_at > ?`).all(now) as Array<{
      millwrightSessionId: string; encryptedCookie: string; worldId: string; foundryUserId: string;
    }>;
  return rows.find(row => createHash("sha256").update(row.millwrightSessionId).digest("hex") === handle) ?? null;
}

export function getFoundryServerSettings(db: DatabaseSync): { encryptedPassword: string | null; adminUsername: string | null; lastWorldId: string | null } {
  const row = db.prepare("SELECT encrypted_admin_password AS encryptedPassword, admin_username AS adminUsername, last_world_id AS lastWorldId FROM foundry_server_settings WHERE id = 1").get();
  if (!row) throw new Error("Foundry settings missing");
  return row as { encryptedPassword: string | null; adminUsername: string | null; lastWorldId: string | null };
}
export function setFoundryAdminCredential(db: DatabaseSync, encrypted: string | null, username: string | null = null): void {
  db.prepare("UPDATE foundry_server_settings SET encrypted_admin_password = ?, admin_username = ? WHERE id = 1").run(encrypted, username);
}
export function rememberActiveFoundryWorld(db: DatabaseSync, worldId: string): void {
  if (!worldId || worldId.length > 128) throw new Error("Invalid world ID");
  db.prepare("UPDATE foundry_server_settings SET last_world_id = ? WHERE id = 1").run(worldId);
}

export type FoundryPendingState = {
  restartPending: number; restartRequestedAt: number | null; restartConfirmedAt: number | null;
  pendingPassword: string | null; pendingUsername: string | null;
  pendingKind: string; verification: string; updatedAt: number; pendingChangeKeys: string;
};
export function getFoundryPendingState(db: DatabaseSync): FoundryPendingState {
  return db.prepare(`SELECT restart_pending AS restartPending, restart_requested_at AS restartRequestedAt,
    restart_confirmed_at AS restartConfirmedAt, pending_password AS pendingPassword,
    pending_username AS pendingUsername, pending_kind AS pendingKind,
    verification, updated_at AS updatedAt, pending_change_keys AS pendingChangeKeys FROM foundry_config_pending WHERE id = 1`).get() as FoundryPendingState;
}
export function recordFoundryConfiguration(db: DatabaseSync, changeKeys: string[],
  pending?: { password: string | null; username: string | null; kind: string }): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (changeKeys.length) {
      const existing = getFoundryPendingState(db);
      const keys = [...new Set([...JSON.parse(existing.pendingChangeKeys) as string[], ...changeKeys])];
      db.prepare("UPDATE foundry_config_pending SET restart_pending = 1, pending_change_keys = ?, updated_at = ? WHERE id = 1")
        .run(JSON.stringify(keys), Date.now());
    }
    if (pending) db.prepare(`UPDATE foundry_config_pending SET pending_password = ?, pending_username = ?,
      pending_kind = ?, verification = 'pending', updated_at = ? WHERE id = 1`)
      .run(pending.password, pending.username, pending.kind, Date.now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function setFoundryPendingVerification(db: DatabaseSync, status: string): void {
  db.prepare("UPDATE foundry_config_pending SET verification = ? WHERE id = 1").run(status);
}
export function markFoundryRestartRequested(db: DatabaseSync): void {
  db.prepare("UPDATE foundry_config_pending SET restart_requested_at = ? WHERE id = 1").run(Date.now());
}
export function markFoundryRestartConfirmed(db: DatabaseSync): void {
  db.prepare(`UPDATE foundry_config_pending SET restart_pending = 0, restart_confirmed_at = ?,
    restart_requested_at = NULL, pending_change_keys = '[]' WHERE id = 1`).run(Date.now());
}
export function discardFoundryPendingCredentials(db: DatabaseSync): void {
  db.prepare(`UPDATE foundry_config_pending SET pending_password = NULL, pending_username = NULL,
    pending_kind = 'none', verification = 'none' WHERE id = 1`).run();
}
