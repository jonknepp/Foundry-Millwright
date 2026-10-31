import { openServiceCredential } from "./service-credentials.js";

const FOUNDRY_ORIGIN = "http://foundry:30000";
type Fetcher = typeof fetch;

function sessionCookie(response: Response): string | null {
  const entries = response.headers.getSetCookie();
  const found = entries.map(entry => entry.split(";", 1)[0])
    .find(entry => /^session=[^;\s]+$/.test(entry));
  return found ?? null;
}

function successful(value: unknown, action: string): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.request === action && data.status === "success" &&
    data.message === "JOIN.LoginSuccess" && data.redirect === "/game";
}

/**
 * Each request owns a fresh Foundry session. The GM-authenticated cookie is
 * never returned: only the cookie after Foundry accepts loginAs is delivered.
 * Foundry is authoritative for the resulting account association.
 */
export async function createFoundryAutologinSession(input: {
  serviceUserId: string;
  encryptedPassword: string;
  credentialKey: Buffer;
  targetUserId: string;
}, fetcher: Fetcher = fetch): Promise<string> {
  if (!input.serviceUserId || !input.targetUserId ||
      input.serviceUserId === input.targetUserId) {
    throw new Error("Invalid autologin account");
  }
  const password = openServiceCredential(input.encryptedPassword, input.credentialKey);
  const initial = await fetcher(FOUNDRY_ORIGIN + "/join", {
    redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  if (initial.status !== 200) throw new Error("Foundry join unavailable");
  let cookie = sessionCookie(initial);
  if (!cookie) throw new Error("Foundry session unavailable");
  const post = async (action: "join" | "loginAs", payload: Record<string, string>) => {
    const response = await fetcher(FOUNDRY_ORIGIN + "/join", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { Cookie: cookie!, "Content-Type": "application/json", Origin: FOUNDRY_ORIGIN },
      body: JSON.stringify({ action, ...payload }),
    });
    if (response.status !== 200) throw new Error("Foundry autologin failed");
    const result: unknown = await response.json();
    if (!successful(result, action)) throw new Error("Foundry autologin rejected");
    cookie = sessionCookie(response) ?? cookie;
  };
  await post("join", { userId: input.serviceUserId, password });
  await post("loginAs", { userId: input.targetUserId });
  return cookie;
}

/** Visiting /join with the managed session clears its authenticated Foundry user. */
export async function terminateFoundrySession(cookie: string, fetcher: Fetcher = fetch): Promise<void> {
  if (!/^session=[^;\s]+$/.test(cookie)) throw new Error("Invalid Foundry session cookie");
  const response = await fetcher(FOUNDRY_ORIGIN + "/join", {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { Cookie: cookie },
  });
  if (response.status !== 200) throw new Error("Foundry session termination failed");
}
