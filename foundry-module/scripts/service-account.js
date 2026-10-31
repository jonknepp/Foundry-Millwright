import { startDiscordLinkIntroduction } from "./onboarding.js";
import { listDiscordMembers, discordMemberLabel } from "./discord-members.js";

/**
 * Service-account creation runs only after a GM explicitly requests it.
 * Middleware independently authenticates the generated credentials before
 * activating them. Never adopt an existing Foundry account by name.
 */
const MODULE = "millwright";
const ACCOUNT_NAME = "Millwright";

function inspect() {
  if (!game.user?.isGM || !game.world?.id) {
    return { ready: false, reason: "Open an active world as a Foundry GM." };
  }
  const id = game.settings.get(MODULE, "serviceAccountUserId");
  if (id) {
    const user = game.users.get(id);
    if (!user) return { ready: false, reason: "The recorded service account is missing; administrator recovery is required." };
    if (!user.isGM) return { ready: false, reason: "The recorded service account is no longer a GM." };
    return { ready: true, reason: "Service account recorded. Middleware credential status can be confirmed by completing provisioning again." };
  }
  if (game.users.some(user => user.name === ACCOUNT_NAME)) {
    return { ready: false, reason: "An account named Millwright already exists. Rename it before provisioning; existing accounts are never adopted by name." };
  }
  return { ready: false, reason: "No service account has been provisioned." };
}

export function inspectServiceAccountProvisioning() {
  return inspect();
}

async function provisioningRequest(action, body) {
  const worldId = game.world.id;
  const response = await fetch(
    `/millwright/api/worlds/${encodeURIComponent(worldId)}/service-account/${action}`,
    {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || `Provisioning failed (HTTP ${response.status})`);
  return result;
}

// Optional onboarding step: link the active GM to the authenticated Discord
// administrator. Never link the dedicated service account or replace mappings.
async function offerGamemasterLink() {
  const gm = game.user;
  if (!gm?.isGM || !game.world?.id) return;
  const me = await fetch("/millwright/api/me", { credentials: "same-origin", cache: "no-store" });
  if (!me.ok) throw new Error("Unable to identify the authenticated Discord user");
  const identity = (await me.json()).identity;
  if (!identity?.userId || !/^[0-9]{17,20}$/.test(identity.userId)) {
    throw new Error("Authenticated Discord identity unavailable");
  }
  const worldId = encodeURIComponent(game.world.id);
  const userId = encodeURIComponent(gm.id);
  const mappingsResponse = await fetch(`/millwright/api/worlds/${worldId}/mappings`, {
    credentials: "same-origin", cache: "no-store",
  });
  if (!mappingsResponse.ok) throw new Error("Unable to inspect existing account mappings");
  const mappings = (await mappingsResponse.json()).mappings;
  if (!Array.isArray(mappings)) throw new Error("Invalid account mapping inventory");
  const existingForGm = mappings.find(mapping => mapping.foundryUserId === gm.id);
  if (existingForGm) {
    if (existingForGm.discordUserId === identity.userId) {
      ui.notifications?.info("Your Foundry Gamemaster is already linked to this Discord account.");
    } else {
      ui.notifications?.warn("This Foundry Gamemaster is already linked to another Discord account.");
    }
    return;
  }
  if (mappings.some(mapping => mapping.discordUserId === identity.userId)) {
    ui.notifications?.warn("Your Discord account is already linked to another Foundry account in this world.");
    return;
  }
  const member = (await listDiscordMembers()).find(item => item.id === identity.userId);
  if (!member) throw new Error("Authenticated Discord user was not found in the configured server");
  const label = discordMemberLabel(member);
  const accepted = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Link Gamemaster to Discord" },
    content: `<p>Link Foundry Gamemaster <strong>${foundry.utils.escapeHTML(gm.name)}</strong> to your authenticated Discord account <strong>${foundry.utils.escapeHTML(label)}</strong>?</p><p>This is optional and will not replace an existing link.</p>`,
    modal: true,
    rejectClose: false,
  });
  if (!accepted) return;
  const mappingUrl = `/millwright/api/worlds/${worldId}/accounts/${userId}/mapping`;
  const requestLink = () => fetch(mappingUrl, {
    method: "PUT", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ discordUserId: identity.userId }),
  });
  let response = await requestLink();
  let result = await response.json().catch(() => null);
  if (response.status === 404 && result?.error === "Foundry account not synchronized") {
    const sync = await fetch("/millwright/api/foundry/accounts/sync", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!sync.ok) throw new Error("Unable to synchronize Foundry accounts");
    response = await requestLink();
    result = await response.json().catch(() => null);
  }
  if (!response.ok) throw new Error(result?.error || `Account linking failed (HTTP ${response.status})`);
  ui.notifications?.info("Foundry Gamemaster linked to your Discord identity.");
}

let provisioningInProgress = false;

async function provision() {
  if (provisioningInProgress) return;
  if (!game.user?.isGM || !game.world?.id) throw new Error("Foundry GM required");
  provisioningInProgress = true;
  try {
    const recordedId = game.settings.get(MODULE, "serviceAccountUserId");
    if (recordedId) {
      const existing = game.users.get(recordedId);
      if (!existing?.isGM) throw new Error("Recorded service account is missing or is not a GM");
      // A previous attempt may have created the account but failed to complete
      // middleware verification. Retry completion without creating a duplicate.
      const result = await provisioningRequest("complete", { foundryUserId: recordedId });
      ui.notifications?.info(`Millwright service account: ${result.status}`);
      try { await offerGamemasterLink(); } catch (error) { ui.notifications?.warn(`Optional GM linking failed: ${error.message}`); }
    startDiscordLinkIntroduction();
      return;
    }
    if (game.users.some(user => user.name === ACCOUNT_NAME)) {
      throw new Error("Account named Millwright already exists; rename it before provisioning");
    }
    const prepared = await provisioningRequest("prepare", {});
    if (prepared.username !== ACCOUNT_NAME || typeof prepared.password !== "string" ||
        !/^[A-Za-z0-9_-]{64}$/.test(prepared.password) ||
        prepared.worldId !== game.world.id) {
      throw new Error("Invalid middleware provisioning response");
    }
    // Persist the newly created ID before completing middleware provisioning
    // so a failed HTTP request can be retried without duplicate account creation.
    const created = await User.create({
      name: ACCOUNT_NAME,
      role: CONST.USER_ROLES.GAMEMASTER,
      password: prepared.password,
    });
    if (!created?.id) throw new Error("Foundry did not return the created account ID");
    await game.settings.set(MODULE, "serviceAccountUserId", created.id);
    const result = await provisioningRequest("complete", { foundryUserId: created.id });
    ui.notifications?.info(`Millwright service account: ${result.status}`);
    try { await offerGamemasterLink(); } catch (error) { ui.notifications?.warn(`Optional GM linking failed: ${error.message}`); }
    startDiscordLinkIntroduction();
  } finally {
    provisioningInProgress = false;
  }
}

export function registerServiceAccountMenu() {
  game.settings.registerMenu(MODULE, "serviceAccount", {
    name: "Service Account",
    label: "Configure",
    hint: "Provision or recover the dedicated Millwright GM service account.",
    icon: "fas fa-user-shield",
    restricted: true,
    type: class ServiceAccountConfiguration extends foundry.applications.api.ApplicationV2 {
      static DEFAULT_OPTIONS = {
        id: "millwright-service-account",
        window: { title: "Millwright — Service Account", resizable: true },
        position: { width: 560, height: 260 },
      };
      async _renderHTML() {
        const state = inspect();
        const section = document.createElement("section");
        section.style.padding = "1rem";
        const heading = document.createElement("h2");
        heading.textContent = state.ready ? "Account recorded" : "Provisioning required";
        const message = document.createElement("p");
        message.textContent = state.reason;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = state.ready ? "Verify / complete provisioning" : "Create Millwright service account";
        button.disabled = !game.user?.isGM || !game.world?.id ||
          (!state.ready && game.users.some(user => user.name === ACCOUNT_NAME));
        const status = document.createElement("p");
        status.setAttribute("role", "status");
        button.addEventListener("click", async () => {
          button.disabled = true;
          status.textContent = "Provisioning…";
          try {
            await provision();
            status.textContent = "Provisioning completed.";
            message.textContent = inspect().reason;
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : "Provisioning failed";
            console.warn("[millwright] Service account provisioning failed:", status.textContent);
          } finally {
            button.disabled = false;
          }
        });
        section.append(heading, message, button, status);
        return section;
      }
      _replaceHTML(result, content) { content.replaceChildren(result); }
    },
  });
}

let initialSetupPromptShown = false;

export async function checkServiceAccountOnReady() {
  if (!game.user?.isGM || !game.world?.id || initialSetupPromptShown) return;
  const state = inspect();
  if (state.ready) { startDiscordLinkIntroduction(); return; }
  initialSetupPromptShown = true;
  if (game.users.some(user => user.name === ACCOUNT_NAME)) {
    console.warn("[millwright] Service account requires recovery:", state.reason);
    ui.notifications?.warn("Millwright service account needs recovery. Open Game Settings → Millwright → Service Account.");
    return;
  }
  try {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Set Up Millwright" },
      content: "<p>Millwright needs a dedicated Foundry Gamemaster service account to manage world access.</p><p>Create and configure this account now? After provisioning, you can optionally link your Gamemaster account to Discord.</p>",
      modal: true,
      rejectClose: false,
    });
    if (!confirmed) {
      ui.notifications?.info("Millwright setup deferred. Open Game Settings → Millwright → Service Account when ready.");
      return;
    }
    await provision();
  } catch (error) {
    console.warn("[millwright] Initial service account setup failed:", error);
    ui.notifications?.error(`Millwright setup failed: ${error instanceof Error ? error.message : "Unknown error"}. Retry in Game Settings → Millwright → Service Account.`);
  }
}
