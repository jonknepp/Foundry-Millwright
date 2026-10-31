const FOUNDRY = "http://foundry:30000";

/**
 * Independently authenticate the provisioned account with Foundry's HTTP
 * login endpoint. Foundry's explicit login success is sufficient; no game
 * socket connection or browser session is required.
 */
export async function verifyFoundryServiceAccount(input: {
  worldId: string; foundryUserId: string; password: string; username?: string;
  onDiagnostic?: (stage: string) => void;
}): Promise<boolean> {
  const initial = await fetch(FOUNDRY + "/join", {
    redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  if (initial.status !== 200) throw new Error("Foundry join initialization failed");
  const cookies = initial.headers.getSetCookie().map(value => value.split(";")[0]);
  if (!cookies.length) throw new Error("Foundry session cookie missing");
  const login = await fetch(FOUNDRY + "/join", {
    method: "POST",
    headers: {
      Cookie: cookies.join("; "),
      "Content-Type": "application/json",
      Origin: new URL(FOUNDRY).origin,
    },
    body: JSON.stringify({ action: "join", userId: input.foundryUserId, password: input.password }),
    redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  input.onDiagnostic?.(`login HTTP status: ${login.status}`);
  if (login.status !== 200) return false;
  const result: unknown = await login.json();
  if (!result || typeof result !== "object") {
    input.onDiagnostic?.("login response is not a JSON object");
    return false;
  }
  const outcome = result as Record<string, unknown>;
  input.onDiagnostic?.(`login response: request=${String(outcome.request)}, status=${String(outcome.status)}, redirect=${String(outcome.redirect)}`);
  return outcome.request === "join" &&
    outcome.status === "success" &&
    outcome.message === "JOIN.LoginSuccess" &&
    outcome.redirect === "/game";
}
