import assert from "node:assert/strict";
import test from "node:test";
import { createFoundryAutologinSession } from "./foundry-autologin.js";
import { sealServiceCredential } from "./service-credentials.js";

const key = Buffer.alloc(32, 7);
const input = {
  serviceUserId: "service-account",
  targetUserId: "mapped-player",
  credentialKey: key,
  encryptedPassword: sealServiceCredential("test-password", key),
};
const success = (action: string) => ({
  request: action, status: "success", message: "JOIN.LoginSuccess", redirect: "/game",
});

test("uses a fresh session, converts it, and returns only the final cookie", async () => {
  const requests: Array<{ action: string; cookie: string; userId: string }> = [];
  const mock = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return new Response("", { status: 200, headers: { "set-cookie": "session=fresh; Path=/; HttpOnly" } });
    const body = JSON.parse(String(init.body)) as { action: string; userId: string; password?: string };
    const cookie = new Headers(init.headers).get("cookie") ?? "";
    requests.push({ action: body.action, cookie, userId: body.userId });
    if (body.action === "join") {
      assert.equal(body.password, "test-password");
      return Response.json(success("join"), { headers: { "set-cookie": "session=gm; Path=/; HttpOnly" } });
    }
    return Response.json(success("loginAs"), { headers: { "set-cookie": "session=player; Path=/; HttpOnly" } });
  }) as typeof fetch;
  const cookie = await createFoundryAutologinSession(input, mock);
  assert.equal(cookie, "session=player");
  assert.deepEqual(requests, [
    { action: "join", cookie: "session=fresh", userId: "service-account" },
    { action: "loginAs", cookie: "session=gm", userId: "mapped-player" },
  ]);
});

test("retains session when Foundry changes association without rotating cookie", async () => {
  let call = 0;
  const mock = (async () => {
    call++;
    return call === 1
      ? new Response("", { status: 200, headers: { "set-cookie": "session=original" } })
      : Response.json(success(call === 2 ? "join" : "loginAs"));
  }) as typeof fetch;
  assert.equal(await createFoundryAutologinSession(input, mock), "session=original");
});

test("does not return a cookie on rejected loginAs", async () => {
  let call = 0;
  const mock = (async () => {
    call++;
    return call === 1
      ? new Response("", { status: 200, headers: { "set-cookie": "session=original" } })
      : Response.json(call === 2 ? success("join") : { request: "loginAs", status: "error" });
  }) as typeof fetch;
  await assert.rejects(createFoundryAutologinSession(input, mock), /rejected/);
});

test("rejects attempts to log in as the service account", async () => {
  await assert.rejects(createFoundryAutologinSession({ ...input, targetUserId: input.serviceUserId }), /Invalid autologin account/);
});
