/**
 * Terminate a Millwright-managed Foundry login using the verified /join behavior.
 * The caller must supply the exact cookie for the target Foundry session.
 * This function does not authenticate, create sessions, or accept arbitrary URLs.
 */
export async function disassociateFoundrySession(
  cookie: string,
  transport: typeof fetch = fetch,
): Promise<void> {
  if (!cookie || cookie.length > 4096 ||
      !/^[A-Za-z0-9_-]+=[A-Za-z0-9._~%+\/-]+$/.test(cookie)) {
    throw new Error("Invalid Foundry session cookie");
  }
  const response = await transport("http://foundry:30000/join", {
    method: "GET",
    headers: { Cookie: cookie },
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  // A redirect is not evidence that the session was disassociated.
  if (response.status !== 200) {
    throw new Error("Foundry session disassociation failed");
  }
}
