import { listDiscordMembers, discordMemberDisplayName, discordMemberLabel } from "./discord-members.js";

/** GM-facing Discord account linking. Foundry remains authoritative for users. */
const MODULE = "millwright";
const SERVICE_NAME = "Millwright";

async function confirmAction(title, message) {
  return foundry.applications.api.DialogV2.confirm({
    window: { title },
    content: `<p>${foundry.utils.escapeHTML(message)}</p>`,
    modal: true,
    rejectClose: false,
  });
}

async function promptUsername(currentName) {
  const safeName = foundry.utils.escapeHTML(currentName);
  return foundry.applications.api.DialogV2.prompt({
    window: { title: "Edit Foundry Username" },
    content: `<form><div class="form-group"><label for="millwright-username-edit">Foundry username</label><input id="millwright-username-edit" type="text" name="username" value="${safeName}" maxlength="100" required autofocus></div></form>`,
    ok: {
      label: "Save",
      callback: (_event, _button, dialog) =>
        dialog.element.querySelector('input[name="username"]')?.value?.trim() ?? "",
    },
    modal: true,
    rejectClose: false,
  });
}

async function api(path, init = {}) {
  const response = await fetch("/millwright/api" + path, {
    credentials: "same-origin", cache: "no-store", ...init,
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) { const error = new Error(result?.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return result;
}

function mappingPath(worldId, userId) {
  return `/worlds/${encodeURIComponent(worldId)}/accounts/${encodeURIComponent(userId)}/mapping`;
}

function element(tag, label, parent) {
  const node = document.createElement(tag);
  if (label !== null) node.textContent = label;
  if (parent) parent.append(node);
  return node;
}

async function synchronizeAccounts() {
  return api("/foundry/accounts/sync", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
}

async function linkAccount(worldId, userId, discordUserId, method) {
  const request = () => api(mappingPath(worldId, userId), {
    method, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ discordUserId }),
  });
  try {
    return await request();
  } catch (error) {
    // The native Foundry user may exist before Millwright has synchronized it.
    // Retry only this specific recoverable condition; never mask mapping conflicts.
    if (method !== "PUT" || error.status !== 404 ||
        error.message !== "Foundry account not synchronized") throw error;
    await synchronizeAccounts();
    return request();
  }
}

class DiscordAccountLinking extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "millwright-discord-account-linking",
    window: { title: "Discord Account Linking", resizable: true },
    position: { width: 850, height: 640 },
  };

  async _renderHTML() {
    const root = element("section", null);
    root.style.cssText = "padding:1rem;overflow:auto;max-height:75vh";
    const status = element("p", "Loading Foundry accounts and Discord members…", root);
    status.setAttribute("role", "status");
    const content = element("div", null, root);
    const show = (value, level = null) => {
      status.textContent = value;
      if (level === "info") ui.notifications?.info(value);
      if (level === "error") ui.notifications?.error(value);
    };

    if (!game.user?.isGM || !game.world?.id) {
      show("Open an active world as a Foundry GM.");
      return root;
    }

    const worldId = game.world.id;
    const serviceId = game.settings.get(MODULE, "serviceAccountUserId");
    let members;
    let mappings;
    try {
      const [discord, saved] = await Promise.all([
        listDiscordMembers(), api(`/worlds/${encodeURIComponent(worldId)}/mappings`),
      ]);
      members = discord;
      mappings = saved.mappings;
      if (!Array.isArray(mappings)) throw new Error("Invalid mapping inventory");
    } catch (error) {
      show("Millwright administrator access is required: " + error.message);
      return root;
    }

    const users = game.users.contents.filter(user => user.id !== serviceId && user.name !== SERVICE_NAME);
    const linked = new Map(mappings.map(mapping => [mapping.foundryUserId, mapping.discordUserId]));
    const assigned = new Map(mappings.map(mapping => [mapping.discordUserId, mapping.foundryUserId]));
    const display = discordMemberDisplayName;

    function memberSelect(currentId = "", userId = "") {
      const select = element("select", null);
      const none = element("option", "Select Discord member…", select);
      none.value = "";
      for (const member of members) {
        const option = element("option", discordMemberLabel(member), select);
        option.value = member.id;
        option.disabled = assigned.has(member.id) && assigned.get(member.id) !== userId;
      }
      if (currentId && !members.some(member => member.id === currentId)) {
        const option = element("option", `Unknown member (${currentId})`, select);
        option.value = currentId;
      }
      select.value = currentId;
      return select;
    }

    const title = element("h2", "Linked Foundry accounts", content);
    title.id = "millwright-tour-existing";
    title.style.marginTop = "0";
    const tableWrap = element("div", null, content);
    tableWrap.style.cssText = "overflow-x:auto;margin-bottom:1.25rem";
    const table = element("table", null, tableWrap);
    table.style.cssText = "width:100%;border-collapse:collapse;background:transparent";
    const head = element("thead", null, table);
    const headings = element("tr", null, head);
    for (const heading of ["Foundry User", "Role", "Discord Account", "Actions"]) {
      const cell = element("th", heading, headings);
      cell.style.cssText = "text-align:left;padding:.4rem;border-bottom:1px solid var(--color-border-light-primary,#666)";
    }
    const body = element("tbody", null, table);
    const roleNames = { 0: "None", 1: "Player", 2: "Trusted Player", 3: "Assistant GM", 4: "Gamemaster" };
    for (const user of users) {
      const row = element("tr", null, body);
      row.style.background = "transparent";
      const nameCell = element("td", null, row);
      const nameLine = element("div", null, nameCell);
      nameLine.style.cssText = "display:flex;align-items:center;gap:.4rem;white-space:nowrap";
      element("span", user.name, nameLine);
      const edit = element("button", null, nameLine);
      edit.type = "button";
      edit.title = "Edit Foundry username";
      edit.setAttribute("aria-label", "Edit username for " + user.name);
      edit.style.cssText = "flex:0 0 auto;width:1.7rem;min-width:1.7rem;height:1.7rem;padding:0;display:inline-flex;align-items:center;justify-content:center";
      const pencil = element("i", null, edit);
      pencil.className = "fas fa-pencil-alt";
      edit.addEventListener("click", async () => {
        edit.disabled = true;
        try {
          const updatedName = await promptUsername(user.name);
          if (updatedName === null || updatedName === undefined || updatedName === user.name) return;
          if (!updatedName || updatedName.length > 100) {
            show("Enter a valid Foundry username (1–100 characters).", "error");
            return;
          }
          if (game.users.some(other => other.id !== user.id && other.name === updatedName)) {
            show("Another Foundry account already uses that username.", "error");
            return;
          }
          await user.update({ name: updatedName });
          show(`Renamed Foundry account "${user.name}" to "${updatedName}".`, "info");
          this.render(true);
        } catch (error) {
          show("Username update failed: " + error.message, "error");
        } finally { edit.disabled = false; }
      });
      const roleCell = element("td", null, row);
      const roleSelect = element("select", null, roleCell);
      roleSelect.setAttribute("aria-label", "Foundry role for " + user.name);
      roleSelect.style.cssText = "width:100%;background:var(--color-cool-5,#28252c);color:var(--color-text-primary,#eee)";
      for (const [value, label] of Object.entries(roleNames)) {
        const option = element("option", label, roleSelect);
        option.value = value;
      }
      roleSelect.value = String(user.role);
      roleSelect.addEventListener("change", async () => {
        const previous = user.role;
        const selected = Number(roleSelect.value);
        if (selected === previous) return;
        roleSelect.disabled = true;
        try {
          const approved = await confirmAction(
            "Change Foundry User Role",
            `Change Foundry role for "${user.name}" from "${roleNames[previous]}" to "${roleNames[selected]}"? This changes the user's permissions within Foundry.`,
          );
          if (!approved) {
            roleSelect.value = String(previous);
            return;
          }
          await user.update({ role: selected });
          show(`Updated Foundry role for "${user.name}" to "${roleNames[selected]}".`, "info");
          this.render(true);
        } catch (error) {
          roleSelect.value = String(previous);
          show("Foundry role update failed: " + error.message, "error");
        } finally {
          roleSelect.disabled = false;
        }
      });
      const associationCell = element("td", null, row);
      const actionCell = element("td", null, row);
      for (const cell of [nameCell, roleCell, associationCell, actionCell]) {
        cell.style.cssText = "padding:.4rem;vertical-align:middle;border-bottom:1px solid var(--color-border-light-tertiary,#444);background:transparent";
      }
      const current = linked.get(user.id) || "";
      const select = memberSelect(current, user.id);
      select.style.cssText = "width:100%;min-width:13rem;background:var(--color-cool-5,#28252c);color:var(--color-text-primary,#eee)";
      select.setAttribute("aria-label", "Discord account for " + user.name);
      associationCell.append(select);
      actionCell.style.cssText += ";white-space:nowrap";
      const actionButtons = element("div", null, actionCell);
      actionButtons.style.cssText = "display:flex;flex-direction:row;align-items:center;gap:.35rem;flex-wrap:nowrap";
      const remove = element("button", "Unlink", actionButtons);
      remove.type = "button";
      remove.disabled = !current;
      if (user.id !== game.user.id && user.role < 4) {
      const del = element("button", "Delete", actionButtons);
      del.type = "button";
      del.style.cssText = "color:var(--color-text-hyperlink,#d66)";
      // GM-level accounts and the active user are protected from this action.
      del.title = "Delete Foundry user and Discord link";
      del.addEventListener("click", async () => {
        if (del.disabled) return;
        const discordMember = members.find(member => member.id === current);
        const association = current
          ? ` Discord association: ${discordMember ? display(discordMember) : current}.`
          : " This account has no Discord association.";
        const approved = await confirmAction(
          "Delete Foundry Account",
          `Permanently delete Foundry account "${user.name}"?${association} Its Discord link will also be removed. This cannot be undone.`,
        );
        if (!approved) return;
        del.disabled = true;
        try {
          // Foundry owns the user lifecycle; only remove the mapping after native deletion succeeds.
          await user.delete();
        } catch (error) {
          show("Foundry account deletion failed: " + error.message, "error");
          del.disabled = false;
          return;
        }
        try {
          if (current) {
            try {
              await api(mappingPath(worldId, user.id), { method: "DELETE" });
            } catch (error) {
              if (error.status !== 404) throw error;
            }
          }
          show(`Deleted Foundry account "${user.name}" and cleared its Discord link.`, "info");
          this.render(true);
        } catch (error) {
          show(`Foundry account "${user.name}" was deleted, but Millwright link cleanup failed: ${error.message}. Use Synchronize Foundry accounts in the Millwright dashboard to remove the stale association.`, "error");
          // Do not retry Foundry deletion; refresh to reflect the remaining accounts.
          this.render(true);
        }
      });
      }
      select.addEventListener("change", async () => {
        const selected = select.value;
        if (!selected || selected === current) {
          select.value = current;
          return;
        }
        select.disabled = true;
        try {
          const oldMember = members.find(member => member.id === current);
          const newMember = members.find(member => member.id === selected);
          const oldLabel = oldMember ? display(oldMember) : current || "No account";
          const newLabel = newMember ? display(newMember) : selected;
          const approved = await confirmAction(
            current ? "Change Discord Account Link" : "Link Discord Account",
            `Link Foundry user "${user.name}" to Discord account "${newLabel}" instead of "${oldLabel}"?`,
          );
          if (!approved) {
            select.value = current;
            return;
          }
          await linkAccount(worldId, user.id, selected, current ? "PATCH" : "PUT");
          show(`Saved link for ${user.name}.`, "info");
          this.render(true);
        } catch (error) {
          select.value = current;
          show(error.message, "error");
        } finally {
          select.disabled = false;
        }
      });
      remove.addEventListener("click", async () => {
        if (!await confirmAction("Unlink Discord Account", `Remove Discord link for ${user.name}? The Foundry account will remain.`)) return;
        remove.disabled = true;
        try {
          await api(mappingPath(worldId, user.id), { method: "DELETE" });
          show(`Removed link for ${user.name}.`, "info");
          this.render(true);
        } catch (error) { show(error.message, "error"); remove.disabled = false; }
      });
    }

    const createHeading = element("h2", "Create and link a player", content);
    createHeading.id = "millwright-tour-create";
    const form = element("form", null, content);
    form.style.cssText = "display:flex;flex-direction:column;gap:.5rem";
    const discord = memberSelect();
    const name = element("input", null);
    name.type = "text";
    name.placeholder = "Foundry username";
    name.required = true;
    name.maxLength = 100;
    discord.addEventListener("change", () => {
      const selected = members.find(member => member.id === discord.value);
      if (selected && !name.value.trim()) name.value = display(selected);
    });
    const role = element("select", null);
    for (const [value, title] of [[1, "Player"], [2, "Trusted Player"], [3, "Assistant GM"], [4, "Gamemaster"]]) {
      const option = element("option", title, role);
      option.value = String(value);
    }
    role.value = "1";
    role.id = "millwright-tour-role";
    const submit = element("button", "Create and link", null);
    submit.type = "submit";
    element("label", "Discord member", form).append(discord);
    element("label", "Foundry username", form).append(name);
    element("label", "Foundry role", form).append(role);
    form.append(submit);
    const recovery = element("p", "", content);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const username = name.value.trim();
      if (!discord.value || !username) { show("Choose a Discord member and username."); return; }
      if (game.users.some(user => user.name === username)) {
        show("A Foundry account with that name already exists. Link it above instead.");
        return;
      }
      if (!await confirmAction("Create and Link Player", `Create Foundry account "${username}" and link it to the selected Discord member?`)) return;
      submit.disabled = true;
      let created = null;
      try {
        // Native Foundry API enforces GM authorization and owns the account.
        created = await User.create({ name: username, role: Number(role.value), password: "" });
        if (!created?.id) throw new Error("Foundry did not return the new account ID");
        // Synchronization is attempted on demand if the new user is not yet registered.
        await linkAccount(worldId, created.id, discord.value, "PUT");
        show(`Created and linked ${username}.`, "info");
        this.render(true);
      } catch (error) {
        show(error.message, "error");
        if (created?.id) {
          recovery.textContent = `Foundry account "${username}" was created (ID: ${created.id}), but linking failed. Use Retry linking below; do not create the account again.`;
          const retry = element("button", "Retry linking", recovery);
          retry.type = "button";
          retry.style.marginLeft = ".5rem";
          retry.addEventListener("click", async () => {
            retry.disabled = true;
            try {
              await linkAccount(worldId, created.id, discord.value, "PUT");
              show(`Linked existing Foundry account "${username}".`, "info");
              this.render(true);
            } catch (retryError) {
              show(`Link retry failed: ${retryError.message}`, "error");
              retry.disabled = false;
            }
          });
        }
      } finally { submit.disabled = false; }
    });
    show(`World: ${worldId} · ${users.length} Foundry accounts · ${mappings.length} links`);
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}

export function registerDiscordAccountLinking() {
  // Foundry v14 renders the Settings sidebar as an ApplicationV2.
  // Insert relative to the native User Management action, not to an assumed index.
  Hooks.on("renderSettings", (_app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    if (root.querySelector("#millwright-discord-account-linking-button")) return;
    const candidates = [...root.querySelectorAll("button, a")];
    const native = candidates.find(node => /user management/i.test(node.textContent?.trim() || ""));
    if (!native) {
      console.warn("[millwright] Native User Management button not found; Discord Account Linking launcher was not inserted.");
      return;
    }
    const button = document.createElement("button");
    button.id = "millwright-discord-account-linking-button";
    button.type = "button";
    button.className = native.className;
    button.innerHTML = '<i class="fas fa-link" aria-hidden="true"></i> Discord Account Linking';
    button.addEventListener("click", () => {
      Hooks.callAll("millwrightDiscordLinkLauncherClicked");
      const window = new DiscordAccountLinking();
      Promise.resolve(window.render(true)).then(() => {
        Hooks.callAll("millwrightDiscordLinkWindowReady", window.element);
      }).catch(error => console.warn("[millwright] Account linking window failed to render:", error));
    });
    native.before(button);
    Hooks.callAll("millwrightDiscordLinkButtonReady", button);
  });
}
