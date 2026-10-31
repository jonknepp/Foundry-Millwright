import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { openServiceCredential, sealServiceCredential } from "./service-credentials.js";

test("service credentials encrypt and decrypt without exposing plaintext", () => {
  const key = randomBytes(32);
  const sealed = sealServiceCredential("unique-service-password", key);
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes("unique-service-password"));
  assert.equal(openServiceCredential(sealed, key), "unique-service-password");
  assert.notEqual(sealServiceCredential("unique-service-password", key), sealed);
});

test("service credential encryption rejects wrong keys and tampering", () => {
  const key = randomBytes(32);
  const sealed = sealServiceCredential("secret", key);
  assert.throws(() => openServiceCredential(sealed, randomBytes(32)));
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => openServiceCredential(parts.join("."), key));
  assert.throws(() => sealServiceCredential("secret", Buffer.alloc(16)));
  assert.throws(() => sealServiceCredential("", key));
  assert.throws(() => openServiceCredential("v1.invalid", key));
});
