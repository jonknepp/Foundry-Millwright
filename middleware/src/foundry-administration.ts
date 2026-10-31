const FOUNDRY_ORIGIN = "http://foundry:30000";
type Fetcher = typeof fetch;

function sessionCookie(response: Response): string | null {
  return response.headers.getSetCookie()
    .map(entry => entry.split(";", 1)[0])
    .find(entry => /^session=[^;\s]+$/.test(entry)) ?? null;
}

export async function createFoundryIntegrationSession(
  integrationSecret: string,
  fetcher: Fetcher = fetch,
  adminUsername = "",
): Promise<string> {
  const initial = await fetcher(FOUNDRY_ORIGIN + "/auth", {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (initial.status !== 200) throw new Error("Foundry authentication unavailable");
  const initialCookie = sessionCookie(initial);
  if (!initialCookie) throw new Error("Foundry session unavailable");

  const response = await fetcher(FOUNDRY_ORIGIN + "/auth", {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: {
      Cookie: initialCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: FOUNDRY_ORIGIN,
    },
    body: new URLSearchParams({
      adminUsername,
      adminPassword: integrationSecret,
      action: "adminAuth",
    }).toString(),
  });
  if (response.status !== 302 || response.headers.get("location") !== "/setup") {
    throw new Error("Foundry integration authentication rejected");
  }
  return sessionCookie(response) ?? initialCookie;
}

/** Explicitly confirmed transition from a running world into Foundry setup. */
export async function shutdownFoundryWorldForAdministration(
  integrationSecret: string,
  fetcher: Fetcher = fetch,
  adminUsername = "",
): Promise<string> {
  const initial = await fetcher(FOUNDRY_ORIGIN + "/join", {
    redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  if (initial.status !== 200) throw new Error("Foundry world join unavailable");
  const initialCookie = sessionCookie(initial);
  if (!initialCookie) throw new Error("Foundry session unavailable");
  const response = await fetcher(FOUNDRY_ORIGIN + "/setup", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
    headers: {
      Cookie: initialCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: FOUNDRY_ORIGIN,
    },
    body: new URLSearchParams({
      action: "worldShutdown",
      adminUsername,
      adminPassword: integrationSecret,
    }).toString(),
  });
  if (response.status !== 302 || response.headers.get("location") !== "/setup") {
    throw new Error(`Foundry world shutdown rejected (HTTP ${response.status}, location: ${JSON.stringify(response.headers.get("location"))})`);
  }
  return sessionCookie(response) ?? initialCookie;
}
