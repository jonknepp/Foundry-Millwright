import { discoverFoundryAccounts } from "./foundry.js";
import { verifyFoundryServiceAccount } from "./foundry-service-verifier.js";

/**
 * Read-only integration diagnostic. Uses an existing Foundry user and does not
 * create, modify, or provision any account. Run only against a test world.
 */
async function main(): Promise<void> {
  const username = process.env.FOUNDRY_TEST_USERNAME;
  const password = process.env.FOUNDRY_TEST_PASSWORD;
  if (!username || !password) {
    throw new Error("Set FOUNDRY_TEST_USERNAME and FOUNDRY_TEST_PASSWORD");
  }
  const inventory = await discoverFoundryAccounts();
  const matching = inventory.accounts.filter(account => account.name === username);
  if (matching.length !== 1) throw new Error("Expected exactly one matching Foundry account");
  const account = matching[0];
  if (account.role !== 4) throw new Error("Test account must have GM role");
  const verified = await verifyFoundryServiceAccount({
    worldId: inventory.worldId,
    foundryUserId: account.id,
    username,
    password,
    onDiagnostic: stage => console.log("CHECK:", stage),
  });
  if (!verified) throw new Error("Authentication or authenticated identity verification failed");
  console.log("PASS: authenticated Foundry GM identity and world verified");
}
main().catch(error => {
  // Avoid logging credentials or raw network response bodies.
  console.error("FAIL:", error instanceof Error ? error.message : "Unknown verification error");
  process.exitCode = 1;
});
