import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";
import { createAccountMapping, getAccountMapping, getActiveSession, openDatabase, registerDiscordIdentity, registerFoundryAccount } from "./database.js";

const secret = "a".repeat(64);
const userA = "267329046881370112";
const userB = "111111111111111111";
const auth = (userId: string) => ({
  "x-millwright-proxy-key": secret,
  "x-millwright-subject": `discord.com/${userId}`,
});

test("world mapping endpoint enforces identity isolation and authentication", async () => {
  const database = openDatabase(":memory:");
  const app = createApp({ database, proxySecret: secret });
  try {
    registerDiscordIdentity(database, userA);
    registerFoundryAccount(database, "world-a", "foundry-a");
    createAccountMapping(database, {
      worldId: "world-a", foundryUserId: "foundry-a", discordUserId: userA,
    });
    const mapped = await app.inject({ method: "GET", url: "/api/worlds/world-a/me", headers: auth(userA) });
    assert.equal(mapped.statusCode, 200);
    assert.deepEqual(mapped.json(), {
      mapping: { worldId: "world-a", foundryUserId: "foundry-a", discordUserId: userA },
    });
    assert.equal(mapped.headers["cache-control"], "no-store");

    const other = await app.inject({ method: "GET", url: "/api/worlds/world-a/me", headers: auth(userB) });
    assert.equal(other.statusCode, 404);
    assert.deepEqual(other.json(), { error: "Account mapping not found" });

    const absent = await app.inject({ method: "GET", url: "/api/worlds/unknown/me", headers: auth(userA) });
    assert.equal(absent.statusCode, 404);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/worlds/world-a/me" });
    assert.equal(unauthenticated.statusCode, 401);

    const wrongSecret = await app.inject({
      method: "GET", url: "/api/worlds/world-a/me",
      headers: { ...auth(userA), "x-millwright-proxy-key": "b".repeat(64) },
    });
    assert.equal(wrongSecret.statusCode, 401);

    const invalidSubject = await app.inject({
      method: "GET", url: "/api/worlds/world-a/me",
      headers: { ...auth(userA), "x-millwright-subject": "discord.com/not-a-user" },
    });
    assert.equal(invalidSubject.statusCode, 401);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/diagnostics/identity", headers: auth(userA) })).statusCode, 404);
  } finally {
    await app.close();
    database.close();
  }
});

test("authenticated requests establish and reuse sessions without changing Discord ownership", async () => {
  const database = openDatabase(":memory:");
  const app = createApp({ database, proxySecret: secret });
  try {
    const initial = await app.inject({ method: "GET", url: "/api/me", headers: auth(userA) });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.headers["cache-control"], "no-store");
    const setCookie = initial.headers["set-cookie"];
    assert.equal(typeof setCookie, "string");
    assert.match(setCookie as string, /Path=\/millwright; HttpOnly; Secure; SameSite=Lax/);
    const cookie = (setCookie as string).split(";")[0];
    const sessionId = cookie.split("=")[1];
    assert.equal(getActiveSession(database, sessionId)?.discordUserId, userA);

    const repeated = await app.inject({
      method: "GET", url: "/api/me", headers: { ...auth(userA), cookie },
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.headers["set-cookie"], undefined);
    assert.equal(getActiveSession(database, sessionId)?.discordUserId, userA);

    const switched = await app.inject({
      method: "GET", url: "/api/me", headers: { ...auth(userB), cookie },
    });
    assert.equal(switched.statusCode, 200);
    assert.ok(switched.headers["set-cookie"]);
    assert.notEqual((switched.headers["set-cookie"] as string).split(";")[0], cookie);
    assert.equal(getActiveSession(database, sessionId)?.discordUserId, userA);

    const invalid = await app.inject({
      method: "GET", url: "/api/me",
      headers: { ...auth(userA), cookie: "millwright_session=invalid" },
    });
    assert.equal(invalid.statusCode, 200);
    assert.ok(invalid.headers["set-cookie"]);

    const unauthenticated = await app.inject({
      method: "GET", url: "/api/me", headers: { cookie },
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.headers["set-cookie"], undefined);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["set-cookie"], undefined);
  } finally {
    await app.close();
    database.close();
  }
});

test("Foundry observations track account switches independently per session", async () => {
  const database = openDatabase(":memory:");
  const app = createApp({ database, proxySecret: secret });
  const url = "/api/worlds/world-a/session/observe";
  const body = (user: string | null, role: number | null) => ({
activeFoundryUserId: user, activeFoundryUserRole: role,
  });
  try {
    const first = await app.inject({ method: "GET", url: "/api/me", headers: auth(userA) });
    const cookie = (first.headers["set-cookie"] as string).split(";")[0];
    const headers = { ...auth(userA), cookie, "sec-fetch-site": "same-origin" };
    const initial = await app.inject({ method: "POST", url, headers, payload: body("foundry-a", 1) });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().observation.activeFoundryUserId, "foundry-a");
    const switched = await app.inject({ method: "POST", url, headers, payload: body("foundry-b", 4) });
    assert.equal(switched.statusCode, 200);
    assert.equal(switched.json().observation.activeFoundryUserRole, 4);
    const logout = await app.inject({ method: "POST", url, headers, payload: body(null, null) });
    assert.equal(logout.statusCode, 200);
    assert.equal(logout.json().observation.activeFoundryUserId, null);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM foundry_sessions").get() as { n: number }).n, 1);
    const foreign = await app.inject({
      method: "POST", url, headers: { ...auth(userB), "sec-fetch-site": "same-origin" },
      payload: body("foundry-a", 1),
    });
    assert.equal(foreign.statusCode, 200);
    const crossSite = await app.inject({
      method: "POST", url, headers: { ...auth(userA), cookie, "sec-fetch-site": "cross-site" },
      payload: body("foundry-a", 1),
    });
    assert.equal(crossSite.statusCode, 403);
    const missing = await app.inject({ method: "POST", url, headers: { ...auth(userA), cookie }, payload: body("foundry-a", 1) });
    assert.equal(missing.statusCode, 403);
    const bad = await app.inject({
      method: "POST", url, headers, payload: { ...body("foundry-a", 1), activeFoundryUserRole: 99 },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM account_mappings").get() as { n: number }).n, 0);
  } finally {
    await app.close();
    database.close();
  }
});

test("administrator bootstrap requires valid challenge, same origin and authenticated identity", async () => {
  const database = openDatabase(":memory:");
  const challenge = "c".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  const url = "/api/admin/bootstrap";
  const headers = { ...auth(userA), "sec-fetch-site": "same-origin" };
  try {
    const status = await app.inject({ method: "GET", url: "/api/admin/status", headers: auth(userA) });
    assert.deepEqual(status.json(), { bootstrapComplete: false, administrator: false });
    assert.equal((await app.inject({ method: "POST", url, payload: { challenge } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: auth(userA), payload: { challenge } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { challenge: "d".repeat(64) } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { challenge: "bad" } })).statusCode, 400);
    const success = await app.inject({ method: "POST", url, headers, payload: { challenge } });
    assert.equal(success.statusCode, 200);
    assert.deepEqual(success.json(), { administrator: true, bootstrapComplete: true });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/admin/status", headers: auth(userA) })).json(),
      { bootstrapComplete: true, administrator: true });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/admin/status", headers: auth(userB) })).json(),
      { bootstrapComplete: true, administrator: false });
    assert.equal((await app.inject({ method: "POST", url, headers: { ...auth(userB), "sec-fetch-site": "same-origin" }, payload: { challenge } })).statusCode, 409);
  } finally {
    await app.close();
    database.close();
  }
});

test("administrator registration page is authenticated, non-cacheable and does not expose challenge", async () => {
  const database = openDatabase(":memory:");
  const challenge = "e".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/admin/bootstrap" })).statusCode, 401);
    const page = await app.inject({ method: "GET", url: "/admin/bootstrap", headers: auth(userA) });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] as string, /text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.headers["content-security-policy"] as string, /frame-ancestors 'none'/);
    assert.match(page.body, /Claim administrator role/);
    assert.doesNotMatch(page.body, new RegExp(challenge));
  } finally {
    await app.close();
    database.close();
  }
});

test("landing page gates dashboard on persistent administrator role", async () => {
  const database = openDatabase(":memory:");
  const challenge = "f".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 401);
    const pending = await app.inject({ method: "GET", url: "/", headers: auth(userA) });
    assert.equal(pending.statusCode, 302);
    assert.equal(pending.headers.location, "/millwright/admin/bootstrap");
    const claim = await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: { challenge } });
    assert.equal(claim.statusCode, 200);
    const dashboard = await app.inject({ method: "GET", url: "/", headers: auth(userA) });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.body, /Millwright Dashboard/);
    assert.ok(dashboard.body.includes('href="/millwright/api/autologin">Join Foundry'));
    assert.ok(!dashboard.body.includes('href="/">Join Foundry'));
    assert.equal(dashboard.headers["cache-control"], "no-store");
    const uninvited = await app.inject({ method: "GET", url: "/", headers: auth(userB) });
    assert.equal(uninvited.statusCode, 403);
    assert.match(uninvited.body, /Not Invited/);
    assert.doesNotMatch(uninvited.body, /Millwright Dashboard/);
    registerDiscordIdentity(database, userB);
    registerFoundryAccount(database, "world-a", "foundry-b");
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "foundry-b", discordUserId: userB });
    const mapped = await app.inject({ method: "GET", url: "/", headers: auth(userB) });
    assert.equal(mapped.statusCode, 302);
    assert.equal(mapped.headers.location, "/millwright/api/autologin");
    assert.doesNotMatch(mapped.body, /Millwright Dashboard/);
  } finally {
    await app.close();
    database.close();
  }
});

test("entry decision distinguishes bootstrap, administrator, mapped and uninvited identities", async () => {
  const database = openDatabase(":memory:");
  const challenge = "b".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/entry" })).statusCode, 401);
    const pending = await app.inject({ method: "GET", url: "/api/entry", headers: auth(userA) });
    assert.deepEqual(pending.json(), { destination: "bootstrap", path: "/millwright/admin/bootstrap" });
    assert.equal(pending.headers["cache-control"], "no-store");
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" },
      payload: { challenge } })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/entry", headers: auth(userA) })).json(),
      { destination: "administrator", path: "/millwright/" });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/entry", headers: auth(userB) })).json(),
      { destination: "not-invited" });
    registerFoundryAccount(database, "world-a", "foundry-b");
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "foundry-b", discordUserId: userB });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/entry", headers: auth(userB) })).json(),
      { destination: "foundry", path: "/millwright/api/autologin" });
  } finally {
    await app.close();
    database.close();
  }
});

test("Foundry ingress authorization fails closed and permits mapped users or administrators", async () => {
  const database = openDatabase(":memory:");
  const challenge = "b".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  const url = "/api/authorize/foundry";
  try {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userA) })).statusCode, 403);
    const claim = await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: { challenge } });
    assert.equal(claim.statusCode, 200);
    const admin = await app.inject({ method: "GET", url, headers: auth(userA) });
    assert.equal(admin.statusCode, 204);
    assert.equal(admin.headers["cache-control"], "no-store");
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userB) })).statusCode, 403);
    registerDiscordIdentity(database, userB);
    registerFoundryAccount(database, "world-a", "foundry-b");
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "foundry-b", discordUserId: userB });
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userB) })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url, headers: {
      ...auth(userB), "x-millwright-proxy-key": "0".repeat(64)
    } })).statusCode, 401);
  } finally {
    await app.close();
    database.close();
  }
});

test("world mapping inventory is administrator-only, scoped, and non-cacheable", async () => {
  const database = openDatabase(":memory:");
  const challenge = "c".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  try {
    const url = "/api/worlds/world-a/mappings";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userA) })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" },
      payload: { challenge } })).statusCode, 200);
    registerDiscordIdentity(database, userB);
    registerFoundryAccount(database, "world-a", "foundry-b");
    registerFoundryAccount(database, "world-b", "foundry-other");
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "foundry-b", discordUserId: userB });
    createAccountMapping(database, { worldId: "world-b", foundryUserId: "foundry-other", discordUserId: userB });
    const allowed = await app.inject({ method: "GET", url, headers: auth(userA) });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers["cache-control"], "no-store");
    assert.deepEqual(allowed.json(), { mappings: [
      { worldId: "world-a", foundryUserId: "foundry-b", discordUserId: userB }
    ] });
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userB) })).statusCode, 403);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/worlds/world-empty/mappings",
      headers: auth(userA) })).json(), { mappings: [] });
    const oversized = await app.inject({ method: "GET",
      url: "/api/worlds/" + "x".repeat(129) + "/mappings", headers: auth(userA) });
    assert.ok([400, 414].includes(oversized.statusCode),
      `Expected request rejection (400 or 414), received ${oversized.statusCode}`);
  } finally {
    await app.close();
    database.close();
  }
});

test("Foundry account discovery requires administrator and never writes mappings", async () => {
  const database = openDatabase(":memory:");
  let calls = 0;
  const app = createApp({
    database, proxySecret: secret, bootstrapChallenge: "d".repeat(64),
    foundryDiscovery: async () => {
      calls++;
      return { worldId: "world-a", accounts: [{ id: "foundry-a", name: "Player", role: 1 }] };
    },
  });
  try {
    const url = "/api/foundry/accounts";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userA) })).statusCode, 403);
    assert.equal(calls, 0);
    assert.equal((await app.inject({
      method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" },
      payload: { challenge: "d".repeat(64) },
    })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userB) })).statusCode, 403);
    const response = await app.inject({ method: "GET", url, headers: auth(userA) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), {
      worldId: "world-a", accounts: [{ id: "foundry-a", name: "Player", role: 1 }],
      serviceAccountUserId: null,
    });
    assert.equal(calls, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM foundry_accounts").get() as { n: number }).n, 0);
  } finally {
    await app.close();
    database.close();
  }
});

test("Foundry discovery failures return a generic gateway error", async () => {
  const database = openDatabase(":memory:");
  const app = createApp({
    database, proxySecret: secret, bootstrapChallenge: "e".repeat(64),
    foundryDiscovery: async () => { throw new Error("sensitive upstream payload"); },
  });
  try {
    await app.inject({
      method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" },
      payload: { challenge: "e".repeat(64) },
    });
    const response = await app.inject({
      method: "GET", url: "/api/foundry/accounts", headers: auth(userA),
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: "Foundry account discovery unavailable" });
    assert.doesNotMatch(response.body, /sensitive/);
  } finally {
    await app.close();
    database.close();
  }
});

test("Foundry sync requires administrator and same-origin, and reconciles only discovered world", async () => {
  const database = openDatabase(":memory:");
  const challenge = "9".repeat(64);
  const app = createApp({
    database, proxySecret: secret, bootstrapChallenge: challenge,
    foundryDiscovery: async () => ({
      worldId: "world-a",
      accounts: [{ id: "current", name: "Player", role: 1 }],
    }),
  });
  const url = "/api/foundry/accounts/sync";
  try {
    registerDiscordIdentity(database, userB);
    registerFoundryAccount(database, "world-a", "stale");
    registerFoundryAccount(database, "world-b", "stale");
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "stale", discordUserId: userB });
    createAccountMapping(database, { worldId: "world-b", foundryUserId: "stale", discordUserId: userB });
    assert.equal((await app.inject({ method: "POST", url, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: auth(userA), payload: {} })).statusCode, 403);
    await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: { challenge } });
    assert.equal((await app.inject({ method: "POST", url,
      headers: { ...auth(userB), "sec-fetch-site": "same-origin" }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers: auth(userA), payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url,
      headers: { ...auth(userA), "sec-fetch-site": "cross-site" }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url,
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: { worldId: "world-b" } })).statusCode, 400);
    const response = await app.inject({ method: "POST", url,
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), { worldId: "world-a", registered: 1, removed: 1 });
    assert.equal(getAccountMapping(database, "world-a", userB), null);
    assert.equal(getAccountMapping(database, "world-b", userB)?.foundryUserId, "stale");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM foundry_accounts WHERE world_id='world-a' AND foundry_user_id='current'").get() as { n: number }).n, 1);
    const repeated = await app.inject({ method: "POST", url,
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: {} });
    assert.deepEqual(repeated.json(), { worldId: "world-a", registered: 1, removed: 0 });
  } finally {
    await app.close();
    database.close();
  }
});

test("Foundry sync preserves mappings when discovery fails or returns invalid inventory", async () => {
  for (const inventory of [null, { worldId: "world-a", accounts: [] },
    { worldId: "world-a", accounts: [
      { id: "same", name: "One", role: 1 }, { id: "same", name: "Two", role: 1 }] }]) {
    const database = openDatabase(":memory:");
    const challenge = "8".repeat(64);
    const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge,
      foundryDiscovery: async () => inventory as never });
    try {
      registerDiscordIdentity(database, userB);
      registerFoundryAccount(database, "world-a", "preserve");
      createAccountMapping(database, { worldId: "world-a", foundryUserId: "preserve", discordUserId: userB });
      await app.inject({ method: "POST", url: "/api/admin/bootstrap",
        headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: { challenge } });
      const response = await app.inject({ method: "POST", url: "/api/foundry/accounts/sync",
        headers: { ...auth(userA), "sec-fetch-site": "same-origin" }, payload: {} });
      assert.equal(response.statusCode, 502);
      assert.equal(getAccountMapping(database, "world-a", userB)?.foundryUserId, "preserve");
    } finally {
      await app.close();
      database.close();
    }
  }
});

test("administrator mapping API enforces authorization, uniqueness, and explicit removal", async () => {
  const database = openDatabase(":memory:");
  const challenge = "7".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  const path = "/api/worlds/world-a/accounts/foundry-a/mapping";
  const headers = { ...auth(userA), "sec-fetch-site": "same-origin" };
  try {
    registerFoundryAccount(database, "world-a", "foundry-a");
    registerFoundryAccount(database, "world-a", "foundry-b");
    registerFoundryAccount(database, "world-b", "foundry-a");
    const payload = { discordUserId: userB };
    assert.equal((await app.inject({ method: "PUT", url: path, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "PUT", url: path, headers, payload })).statusCode, 403);
    await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers, payload: { challenge } });
    assert.equal((await app.inject({ method: "PUT", url: path,
      headers: { ...auth(userB), "sec-fetch-site": "same-origin" }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: path,
      headers: auth(userA), payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: path,
      headers, payload: { discordUserId: "bad" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/worlds/world-a/accounts/unknown/mapping",
      headers, payload })).statusCode, 404);
    const created = await app.inject({ method: "PUT", url: path, headers, payload });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json(), { mapping: {
      worldId: "world-a", foundryUserId: "foundry-a", discordUserId: userB } });
    assert.equal((await app.inject({ method: "PUT", url: path, headers, payload })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: path, headers,
      payload: { discordUserId: userA } })).statusCode, 409);
    assert.equal((await app.inject({ method: "PUT",
      url: "/api/worlds/world-a/accounts/foundry-b/mapping", headers, payload })).statusCode, 409);
    assert.equal((await app.inject({ method: "PUT",
      url: "/api/worlds/world-b/accounts/foundry-a/mapping", headers, payload })).statusCode, 201);
    assert.equal((await app.inject({ method: "DELETE", url: path,
      headers: auth(userA) })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: path, headers })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: path, headers })).statusCode, 404);
    assert.equal(getAccountMapping(database, "world-a", userB), null);
    assert.equal(getAccountMapping(database, "world-b", userB)?.foundryUserId, "foundry-a");
  } finally {
    await app.close();
    database.close();
  }
});

test("PATCH reassigns an existing mapping atomically without displacement", async () => {
  const database = openDatabase(":memory:");
  const challenge = "6".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  const path = "/api/worlds/world-a/accounts/foundry-a/mapping";
  const headers = { ...auth(userA), "sec-fetch-site": "same-origin" };
  const userC = "222222222222222222";
  try {
    registerDiscordIdentity(database, userA);
    registerDiscordIdentity(database, userB);
    registerFoundryAccount(database, "world-a", "foundry-a");
    registerFoundryAccount(database, "world-a", "foundry-b");
    registerFoundryAccount(database, "world-b", "foundry-a");
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "foundry-a", discordUserId: userB });
    createAccountMapping(database, { worldId: "world-a", foundryUserId: "foundry-b", discordUserId: userA });
    createAccountMapping(database, { worldId: "world-b", foundryUserId: "foundry-a", discordUserId: userB });
    assert.equal((await app.inject({ method: "PATCH", url: path,
      headers, payload: { discordUserId: userC } })).statusCode, 403);
    await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers, payload: { challenge } });
    assert.equal((await app.inject({ method: "PATCH", url: path,
      headers: { ...auth(userB), "sec-fetch-site": "same-origin" },
      payload: { discordUserId: userC } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: path,
      headers: auth(userA), payload: { discordUserId: userC } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: path,
      headers, payload: { discordUserId: "bad" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: path,
      headers, payload: { discordUserId: userA } })).statusCode, 409);
    assert.equal(getAccountMapping(database, "world-a", userB)?.foundryUserId, "foundry-a");
    assert.equal((await app.inject({ method: "PATCH",
      url: "/api/worlds/world-a/accounts/unknown/mapping",
      headers, payload: { discordUserId: userC } })).statusCode, 404);
    const updated = await app.inject({ method: "PATCH", url: path,
      headers, payload: { discordUserId: userC } });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json(), { mapping: {
      worldId: "world-a", foundryUserId: "foundry-a", discordUserId: userC } });
    assert.equal((await app.inject({ method: "PATCH", url: path,
      headers, payload: { discordUserId: userC } })).statusCode, 200);
    assert.equal(getAccountMapping(database, "world-a", userB), null);
    assert.equal(getAccountMapping(database, "world-a", userC)?.foundryUserId, "foundry-a");
    assert.equal(getAccountMapping(database, "world-b", userB)?.foundryUserId, "foundry-a");
  } finally {
    await app.close();
    database.close();
  }
});

test("administrator account mapping page is restricted and supplies same-origin CSP", async () => {
  const database = openDatabase(":memory:");
  const challenge = "5".repeat(64);
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: challenge });
  try {
    const url = "/admin/mappings";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userA) })).statusCode, 403);
    const headers = { ...auth(userA), "sec-fetch-site": "same-origin" };
    const claimed = await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers, payload: { challenge } });
    assert.equal(claimed.statusCode, 200);
    const response = await app.inject({ method: "GET", url, headers: auth(userA) });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-security-policy"] as string, /connect-src 'self'/);
    assert.match(response.headers["content-security-policy"] as string, /form-action 'none'/);
    assert.match(response.body, /Foundry Account Mappings/);
    assert.match(response.body, /\/millwright\/api/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal((await app.inject({ method: "GET", url, headers: auth(userB) })).statusCode, 403);
  } finally {
    await app.close();
    database.close();
  }
});

test("session inventory is administrator-only and uses non-secret handles", async () => {
  const database = openDatabase(":memory:");
  const app = createApp({ database, proxySecret: secret, bootstrapChallenge: "6".repeat(64) });
  try {
    const claim = await app.inject({ method: "POST", url: "/api/admin/bootstrap",
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" },
      payload: { challenge: "6".repeat(64) } });
    assert.equal(claim.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/sessions", headers: auth(userB) })).statusCode, 403);
    await app.inject({ method: "GET", url: "/api/me", headers: auth(userB) });
    const result = await app.inject({ method: "GET", url: "/api/admin/sessions", headers: auth(userA) });
    assert.equal(result.statusCode, 200);
    const entry = result.json().sessions.find((s: { discordUserId: string }) => s.discordUserId === userB);
    assert.match(entry.sessionHandle, /^[a-f0-9]{64}$/);
    const endpoint = "/api/admin/sessions/" + entry.sessionHandle;
    assert.equal((await app.inject({ method: "DELETE", url: endpoint, headers: auth(userA) })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: endpoint,
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" } })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: endpoint,
      headers: { ...auth(userA), "sec-fetch-site": "same-origin" } })).statusCode, 404);
  } finally {
    await app.close();
    database.close();
  }
});
