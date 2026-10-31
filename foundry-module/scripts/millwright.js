/**
 * Millwright world-session observer.
 * Reports client-observed state only; middleware must never treat it as proof
 * of Foundry authorization. Discord authentication remains proxy-controlled.
 */
import { registerDiscordAccountLinking } from "./account-linking.js";
import { registerServiceAccountMenu, checkServiceAccountOnReady } from "./service-account.js";
import { registerDiscordLinkIntroduction } from "./onboarding.js";

const MODULE_ID = "millwright";

async function reportSession() {
  const worldId = game.world?.id;
  if (!worldId) {
    console.warn(`[${MODULE_ID}] World identifier unavailable; observation skipped`);
    return;
  }

  const activeFoundryUserId = game.user?.id ?? null;
  const activeFoundryUserRole = game.user?.role ?? null;
  const endpoint = `/millwright/api/worlds/${encodeURIComponent(worldId)}/session/observe`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        activeFoundryUserId,
        activeFoundryUserRole,
      }),
    });
    if (!response.ok) {
      console.warn(`[${MODULE_ID}] Session observation rejected (HTTP ${response.status})`);
    }
  } catch (error) {
    console.warn(`[${MODULE_ID}] Middleware session observation unavailable`, error);
  }
}

Hooks.once("init", () => {
  registerDiscordAccountLinking();
  registerDiscordLinkIntroduction();
  game.settings.register(MODULE_ID, "serviceAccountUserId", {scope:"world",config:false,type:String,default:"",restricted:true});
  registerServiceAccountMenu();
});

Hooks.once("ready", () => {
  checkServiceAccountOnReady();
  void reportSession();
});
