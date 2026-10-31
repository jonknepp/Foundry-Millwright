import assert from "node:assert/strict";
import test from "node:test";
import { disassociateFoundrySession } from "./foundry-session.js";

test("disassociation sends only the targeted session cookie to Foundry /join", async () => {
  let calls = 0;
  await disassociateFoundrySession("session=abc123", async (url, options) => {
    calls++;
    assert.equal(url, "http://foundry:30000/join");
    assert.equal(options?.method, "GET");
    assert.equal((options?.headers as Record<string, string>).Cookie, "session=abc123");
    assert.equal(options?.redirect, "manual");
    return new Response("", { status: 200 });
  });
  assert.equal(calls, 1);
});

test("disassociation rejects redirects, failures, and malformed cookies", async () => {
  for (const status of [302, 401, 500]) {
    await assert.rejects(
      disassociateFoundrySession("session=abc123", async () => new Response(null, { status })),
      /disassociation failed/,
    );
  }
  await assert.rejects(disassociateFoundrySession("session=x; other=y"), /Invalid Foundry session cookie/);
});
