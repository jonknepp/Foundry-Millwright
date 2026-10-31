import { sealServiceCredential, openServiceCredential } from "./service-credentials.js";
import { getFoundryServerSettings, setFoundryAdminCredential, rememberActiveFoundryWorld, getFoundryPendingState, recordFoundryConfiguration, setFoundryPendingVerification, markFoundryRestartRequested, markFoundryRestartConfirmed, discardFoundryPendingCredentials } from "./database.js";
import { createFoundryIntegrationSession, shutdownFoundryWorldForAdministration } from "./foundry-administration.js";
import { createFoundryAutologinSession, terminateFoundrySession } from "./foundry-autologin.js";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { discoverFoundryAccounts } from "./foundry.js";
import { prepareServiceProvisioning } from "./service-provisioning-pending.js";
import { completeServiceProvisioning } from "./service-provisioning-complete.js";
import { verifyFoundryServiceAccount } from "./foundry-service-verifier.js";
import { getStoredServiceCredential, storeManagedFoundrySession, getManagedFoundrySessionByHandle } from "./database.js";
import { listGuildMembers } from "./discord.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseDiscordSubject } from "./identity.js";
import { createSession, getActiveSession, getAccountMapping, registerDiscordIdentity, touchSession, observeFoundrySession, claimInitialAdministrator, isAdministratorBootstrapComplete, isMillwrightAdministrator, getAccountMappingsForDiscordIdentity, getAccountMappingsForWorld, reconcileFoundryAccounts, saveFoundryPlayerMetadata, createAccountMapping, getMappingByFoundryAccount, removeAccountMapping, updateAccountMapping, listActiveSessions, updateDiscordIdentityName, revokeSessionByHandle, purgeExpiredSessions, purgeUnmanagedSessions } from "./database.js";

// Shared, dependency-free confirmation UI for middleware-served pages.
const millwrightDialogScript = "function ensureMillwrightDialogStyle() {\n  if (document.getElementById(\"millwright-dialog-style\")) return;\n  const style = document.createElement(\"style\");\n  style.id = \"millwright-dialog-style\";\n  style.textContent = \".millwright-dialog{background:#1f2937;color:#f9fafb;border:1px solid #64748b;border-radius:.7rem;max-width:min(90vw,32rem);padding:1.5rem;box-shadow:0 20px 60px #0009}.millwright-dialog::backdrop{background:#000b}.millwright-dialog h2{margin:0 0 1rem;font-size:1.25rem}.millwright-dialog p{line-height:1.5}.millwright-dialog-actions{display:flex;justify-content:flex-end;gap:.75rem;margin-top:1.5rem}.millwright-dialog-actions button{font:inherit;cursor:pointer;border-radius:.35rem;padding:.6rem 1rem;border:1px solid #64748b;background:#374151;color:#f9fafb}.millwright-dialog-actions .millwright-dialog-danger{background:#b91c1c;border-color:#ef4444;color:white}.millwright-dialog-actions button:not(.millwright-dialog-danger):last-child{background:#93c5fd;color:#111827}.millwright-dialog .millwright-dialog-actions button:focus{outline:3px solid #fbbf24;outline-offset:2px}\";\n  document.head.append(style);\n}\nasync function millwrightConfirm(message, options = {}) {\n  const opener = document.activeElement;\n  const dialog = document.createElement(\"dialog\");\n  dialog.className = \"millwright-dialog\";\n  dialog.setAttribute(\"aria-labelledby\", \"millwright-dialog-title\");\n  dialog.setAttribute(\"aria-describedby\", \"millwright-dialog-description\");\n  const title = document.createElement(\"h2\");\n  title.id = \"millwright-dialog-title\";\n  title.textContent = options.title || \"Confirm action\";\n  const description = document.createElement(\"p\");\n  description.id = \"millwright-dialog-description\";\n  description.textContent = message;\n  const actions = document.createElement(\"div\");\n  actions.className = \"millwright-dialog-actions\";\n  const cancel = document.createElement(\"button\");\n  cancel.type = \"button\";\n  cancel.textContent = \"Cancel\";\n  const accept = document.createElement(\"button\");\n  accept.type = \"button\";\n  accept.textContent = options.confirmLabel || \"Confirm\";\n  if (options.destructive) accept.className = \"millwright-dialog-danger\";\n  actions.append(cancel, accept);\n  dialog.append(title, description, actions);\n  ensureMillwrightDialogStyle();\n  document.body.append(dialog);\n  return new Promise(resolve => {\n    let approved = false;\n    cancel.addEventListener(\"click\", () => dialog.close());\n    accept.addEventListener(\"click\", () => { approved = true; dialog.close(); });\n    dialog.addEventListener(\"close\", () => {\n      dialog.remove();\n      if (opener && opener.isConnected && typeof opener.focus === \"function\") opener.focus();\n      resolve(approved);\n    }, { once: true });\n    dialog.showModal();\n    cancel.focus();\n  });\n}";

declare module "fastify" {
  interface FastifyRequest {
    discordIdentity: ReturnType<typeof parseDiscordSubject>;
    millwrightSessionId: string | null;
  }
}

export function createApp(options: {
  database: DatabaseSync;
  serviceCredentialKey?: Buffer;
  serviceAccountVerifier?: typeof verifyFoundryServiceAccount;
  proxySecret: string;
  bootstrapChallenge?: string;
  identityDiagnostic?: boolean;
  logger?: boolean;
  discordGuildId?: string;
  discordBotToken?: string;
  foundryDiscovery?: typeof discoverFoundryAccounts;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.proxySecret)) throw new Error("Invalid middleware proxy secret");
  const expectedSecret = Buffer.from(options.proxySecret, "utf8");
  if (options.bootstrapChallenge !== undefined && !/^[a-f0-9]{64}$/.test(options.bootstrapChallenge)) {
    throw new Error("Invalid administrator bootstrap challenge");
  }
  const expectedChallengeHash = options.bootstrapChallenge
    ? createHash("sha256").update(options.bootstrapChallenge).digest() : null;
  const sessionCookie = "millwright_session";
  const sessionTtlMs = 24 * 60 * 60 * 1000;
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  app.decorateRequest("discordIdentity", null);
  app.decorateRequest("millwrightSessionId", null);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/health") return;
    const supplied = request.headers["x-millwright-proxy-key"];
    const candidate = typeof supplied === "string" ? Buffer.from(supplied, "utf8") : Buffer.alloc(0);
    if (candidate.length !== expectedSecret.length || !timingSafeEqual(candidate, expectedSecret)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const identity = parseDiscordSubject(request.headers["x-millwright-subject"]);
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    request.discordIdentity = identity;
    // Caddy forward_auth runs on every Foundry request. Its subrequest cannot
    // establish a browser-scoped Millwright cookie, so never create a session.
    if (request.url.split("?")[0] === "/api/authorize/foundry") return;
    // Cookie is scoped to Millwright's public Caddy route, not Foundry.
    const cookieHeader = request.headers.cookie;
    const cookies = typeof cookieHeader === "string" ? cookieHeader.split(";") : [];
    const values = cookies.map(part => part.trim()).filter(part => part.startsWith(sessionCookie + "="))
      .map(part => part.slice(sessionCookie.length + 1));
    const existing = values.length === 1 && /^[a-f0-9]{64}$/.test(values[0])
      ? getActiveSession(options.database, values[0]) : null;
    if (existing && existing.discordUserId === identity.userId) {
      touchSession(options.database, existing.sessionId);
      request.millwrightSessionId = existing.sessionId;
    } else {
      // Never rebind a session to a different Discord identity.
      registerDiscordIdentity(options.database, identity.userId);
      const session = createSession(options.database, identity.userId, sessionTtlMs);
      request.millwrightSessionId = session.sessionId;
      reply.header("Set-Cookie",
        `${sessionCookie}=${session.sessionId}; Path=/millwright; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionTtlMs / 1000}`);
    }
  });

  // Middleware landing page; never grant dashboard access based on client-reported Foundry roles.
  // Internal Caddy forward_auth endpoint. Only the trusted proxy may supply
  // the authenticated Discord subject; the onRequest hook verifies its secret.
  app.get("/api/authorize/foundry", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    if (!isAdministratorBootstrapComplete(options.database)) {
      return reply.code(403).send({ error: "Administrator setup required" });
    }
    if (isMillwrightAdministrator(options.database, identity.userId) ||
        getAccountMappingsForDiscordIdentity(options.database, identity.userId).length > 0) {
      return reply.code(204).send();
    }
    return reply.code(403).send({ error: "Not invited" });
  });


  // Waiting-room presence is ephemeral and scoped to authenticated, mapped players.
  // No Discord voice-status claims are made.
  const waiting = new Map<string, number>();
  const waitingTtl = 60_000;
  async function connectionState(): Promise<"offline" | "waiting" | "ready"> {
    try {
      const response = await fetch("http://foundry:30000/auth", {
        redirect: "manual", signal: AbortSignal.timeout(3000),
      });
      if (response.status !== 200 && response.status !== 302) return "offline";
      // Foundry redirects /auth to /join when a world is running.
      if (response.status === 302 && response.headers.get("location") === "/join") return "ready";
      return "waiting";
    } catch { return "offline"; }
  }
  app.get("/api/connect/status", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({error:"Unauthorized"});
    if (!isAdministratorBootstrapComplete(options.database)) return reply.code(403).send({error:"Setup required"});
    const admin = isMillwrightAdministrator(options.database, identity.userId);
    const mappings = getAccountMappingsForDiscordIdentity(options.database, identity.userId);
    if (!admin && !mappings.length) return reply.code(403).send({error:"Not invited"});
    const state = await connectionState();
    if (!admin) waiting.set(identity.userId, Date.now());
    const now = Date.now();
    for (const [id, at] of waiting) if (now - at > waitingTtl) waiting.delete(id);
    const lastWorldId = getFoundryServerSettings(options.database).lastWorldId;
    const players = [...waiting.keys()].map(id => {
      const row = options.database.prepare("SELECT display_name AS displayName, username FROM discord_identities WHERE discord_user_id = ?").get(id) as {displayName?:string|null;username?:string|null}|undefined;
      const player = lastWorldId ? options.database.prepare("SELECT a.player_name AS playerName, a.player_role AS playerRole FROM account_mappings m JOIN foundry_accounts a ON a.world_id = m.world_id AND a.foundry_user_id = m.foundry_user_id WHERE m.world_id = ? AND m.discord_user_id = ?").get(lastWorldId,id) as {playerName:string|null;playerRole:number|null}|undefined : undefined;
      return {discordUser:row?.displayName||row?.username||"Discord user",foundryPlayer:player?.playerName??null,foundryRole:player?.playerRole??null};
    });
    return { state, administrator: admin, players, discordGuildId: options.discordGuildId ?? null };
  });
  app.get("/connect", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({error:"Unauthorized"});
    if (!isAdministratorBootstrapComplete(options.database)) return reply.redirect("/millwright/admin/bootstrap");
    const admin = isMillwrightAdministrator(options.database, identity.userId);
    if (!admin && !getAccountMappingsForDiscordIdentity(options.database, identity.userId).length)
      return reply.code(403).send({error:"Not invited"});
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Millwright — Waiting Room</title><style>body{font:16px system-ui,sans-serif;background:#111827;color:#f9fafb;max-width:42rem;margin:4rem auto;padding:1rem}section{background:#1f2937;padding:1.5rem;border-radius:.6rem}a{color:#93c5fd}li{padding:.4rem}</style></head><body><h1>Millwright</h1><section><h2 id="heading">Connecting…</h2><p id="status" role="status" aria-live="polite">Checking Foundry availability…</p><h3>Who's Waiting</h3><ul id="players"></ul><p><a id="discord" hidden target="_blank" rel="noopener noreferrer">Open Discord</a></p><p><a href="/millwright/">Millwright Home</a></p></section><script>
const heading=document.getElementById("heading"),status=document.getElementById("status"),players=document.getElementById("players");
let navigating=false;
async function refresh(){
 if(navigating)return;
 try{
  const response=await fetch("/millwright/api/connect/status",{cache:"no-store",credentials:"same-origin"});
  if(!response.ok)throw Error("Connection status unavailable");
  const data=await response.json();
  if(data.state==="ready"){
   navigating=true;status.textContent="World available. Connecting…";
   window.location.replace(data.administrator?"/millwright/":"/millwright/api/autologin");return;
  }
  heading.textContent=data.state==="offline"?"Foundry temporarily unavailable":"Waiting Room";
  status.textContent=data.state==="offline"?"Waiting for Foundry to restart…":"Waiting for the Game Master to start a world.";
  players.replaceChildren();
  for(const player of data.players){const item=document.createElement("li");const roles={0:"None",1:"Player",2:"Trusted Player",3:"Assistant GM",4:"Gamemaster"};item.textContent=player.discordUser+(player.foundryPlayer?" — "+player.foundryPlayer:"")+(player.foundryRole!==null?" ("+(roles[player.foundryRole]||"Unknown")+")":"");players.append(item);}
  const discord=document.getElementById("discord");if(data.discordGuildId){discord.href="https://discord.com/channels/"+data.discordGuildId;discord.hidden=false;}
 }catch(error){heading.textContent="Connection unavailable";status.textContent="Retrying connection…";}
}
refresh();setInterval(refresh,5000);
</script></body></html>`;
  });

  app.get("/api/entry", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    if (!isAdministratorBootstrapComplete(options.database)) {
      return { destination: "bootstrap", path: "/millwright/admin/bootstrap" };
    }
    if (isMillwrightAdministrator(options.database, identity.userId)) {
      return { destination: "administrator", path: "/millwright/" };
    }
    const mappings = getAccountMappingsForDiscordIdentity(options.database, identity.userId);
    if (mappings.length > 0) {
      return { destination: "foundry", path: "/millwright/connect" };
    }
    return { destination: "not-invited" };
  });

  app.get("/", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    if (!isAdministratorBootstrapComplete(options.database)) {
      return reply.redirect("/millwright/admin/bootstrap");
    }
    if (!isMillwrightAdministrator(options.database, identity.userId)) {
      if (getAccountMappingsForDiscordIdentity(options.database, identity.userId).length > 0) {
        return reply.redirect("/millwright/connect");
      }
      reply.code(403);
      reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      reply.type("text/html; charset=utf-8");
      return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Millwright — Not Invited</title><body><h1>Not Invited</h1><p>Contact your game master for access to a Foundry world.</p></body></html>';
    }
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Millwright Dashboard</title><style>
body{font:16px system-ui,sans-serif;background:#111827;color:#f9fafb;max-width:55rem;margin:4rem auto;padding:1rem}
a{color:#93c5fd}nav{display:flex;gap:1rem;flex-wrap:wrap}section{background:#1f2937;border-radius:.6rem;padding:1.5rem;margin-top:1.5rem}dialog{background:#1f2937;color:#f9fafb;border:1px solid #64748b;border-radius:.7rem;max-width:32rem;padding:1.5rem}dialog::backdrop{background:rgba(0,0,0,.75)}dialog button{font:inherit;padding:.6rem;margin:.3rem;cursor:pointer}
</style></head><body><h1>Millwright Dashboard</h1><p>Administrator access verified.</p>
<nav><a id="join-foundry" href="/millwright/api/autologin" hidden>Join Foundry</a><a id="open-administration" href="/millwright/api/admin/foundry/open" hidden>Open Administration</a><a id="foundry-setup" href="/setup" hidden>Foundry Setup</a><a href="/millwright/admin/foundry/settings">Integration Settings</a><a href="/millwright/admin/mappings">Account Mappings</a></nav>\n<section><h2>Server Status &amp; Health</h2><p id="server-status" role="status">Checking server…</p><p id="world-status"></p><button id="world-start" type="button" hidden>Start world</button></section>
<dialog id="shutdown-dialog" class="millwright-dialog" aria-labelledby="shutdown-title" aria-describedby="shutdown-description"><h2 id="shutdown-title">Shut down the active Foundry world?</h2><p id="shutdown-description">Opening Foundry Administration requires shutting down the active world. All connected players will be disconnected, and unsaved activity may be lost.</p><p id="shutdown-world"></p><p id="shutdown-error" role="alert"></p><div class="millwright-dialog-actions"><button id="shutdown-cancel" type="button">Cancel</button><button id="shutdown-confirm" class="millwright-dialog-danger" type="button">Shut Down World &amp; Open Administration</button></div></dialog>\n<section id="foundry-config-alert" hidden><h2>Foundry Administrative Configuration</h2><p id="foundry-config-message" role="alert"></p><button type="button" id="foundry-config-restart">Restart Foundry Server</button> <button type="button" id="foundry-config-retry">Retry Verification</button> <button type="button" id="foundry-config-discard">Discard Pending Credentials</button> <p id="foundry-config-result" role="status"></p></section>
<section><h2>Session management</h2><p>Active Millwright sessions. Termination also signs out tracked Foundry sessions using the server-side /join endpoint.</p>
<button id="sessions-refresh" type="button">Refresh sessions</button> <button id="sessions-cleanup" type="button">Clean up untracked sessions</button> <label>View <select id="sessions-filter"><option value="tracked">Foundry observations</option><option value="all">All sessions</option></select></label>
<p id="sessions-status" role="status" aria-live="polite">Loading sessions…</p>
<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">Discord user</th><th style="text-align:left">Foundry user</th><th style="text-align:left">World</th><th style="text-align:left">Last seen</th><th style="text-align:left">Expires</th><th>Action</th></tr></thead><tbody id="sessions-rows"></tbody></table></div>
</section>
<script>
${millwrightDialogScript}
"use strict";
const configAlert=document.getElementById("foundry-config-alert");
const configMessage=document.getElementById("foundry-config-message");
const configResult=document.getElementById("foundry-config-result");
async function configAction(path) {
 const response=await fetch("/millwright/api/admin/foundry/"+path,{method:"POST",credentials:"same-origin"});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||"HTTP "+response.status);
 return data;
}
async function refreshConfigAlert(){
 try {
  const response=await fetch("/millwright/api/admin/foundry/config-pending",{cache:"no-store"});
  if(!response.ok)return;
  const state=await response.json();
  configAlert.hidden=!state.restartPending&&!state.credentialsPending;
  if(state.restartRequestedAt){
   try {await configAction("restart/confirm");configResult.textContent="Foundry restart confirmed.";return refreshConfigAlert();}
   catch { /* Restart may still be in progress. */ }
  }
  configMessage.textContent=state.restartPending?"Foundry administrative configuration changes require a server restart. You may defer it.":"";
  if(state.credentialsPending){
   configMessage.textContent+=(state.restartPending?" ":"")+"Administrator credentials are pending verification. "+(
    state.verification==="both-invalid"?"Neither pending nor previous credentials authenticated.":
    state.verification==="pending-invalid-previous-valid"?"Pending credentials failed, but previous credentials still work.":"");
  }
  document.getElementById("foundry-config-restart").hidden=!state.restartPending;
  document.getElementById("foundry-config-retry").hidden=!state.credentialsPending;
  document.getElementById("foundry-config-discard").hidden=!state.credentialsPending;
 }catch(error){configResult.textContent=error.message;}
}
document.getElementById("foundry-config-restart").addEventListener("click",async()=>{
 if(!await millwrightConfirm("Restart Foundry server? Connected players will be disconnected.", {title:"Restart Foundry Server",confirmLabel:"Restart Server",destructive:true}))return;
 try{
  await configAction("restart");
  configResult.textContent="Restart requested; waiting for Foundry to return.";
  for(let i=0;i<60;i++){
   await new Promise(resolve=>setTimeout(resolve,2000));
   try{
    const outcome=await configAction("restart/confirm");
    configResult.textContent="Restart confirmed. Credential verification: "+(outcome.verification?.status||"none");
    break;
   }catch(error){if(i===59)configResult.textContent="Restart confirmation unavailable: "+error.message;}
  }
 }catch(error){configResult.textContent=error.message;}
 await refreshConfigAlert();
});
document.getElementById("foundry-config-retry").addEventListener("click",async()=>{
 try{const result=await configAction("config-pending/verify");configResult.textContent="Credential verification: "+result.status;}
 catch(error){configResult.textContent=error.message;}
 await refreshConfigAlert();
});
document.getElementById("foundry-config-discard").addEventListener("click",async()=>{
 if(!await millwrightConfirm("Discard pending credentials? Foundry configuration will not be changed.", {title:"Discard Pending Credentials",confirmLabel:"Discard Credentials",destructive:true}))return;
 try{await configAction("config-pending/discard");configResult.textContent="Pending credentials discarded.";}
 catch(error){configResult.textContent=error.message;}
 await refreshConfigAlert();
});
refreshConfigAlert();
const adminLink=document.getElementById("open-administration"),joinLink=document.getElementById("join-foundry"),setupLink=document.getElementById("foundry-setup"),shutdownDialog=document.getElementById("shutdown-dialog"),shutdownCancel=document.getElementById("shutdown-cancel"),shutdownConfirm=document.getElementById("shutdown-confirm"),shutdownError=document.getElementById("shutdown-error");
adminLink.addEventListener("click",async event=>{
 event.preventDefault();
 try{
  const response=await fetch("/millwright/api/admin/server/status",{cache:"no-store"});
  if(!response.ok)throw Error("Unable to check Foundry status");
  const state=await response.json();
  if(state.foundry!=="online")throw Error("Foundry is unavailable");
   if(!state.credentialConfigured){window.location.assign("/setup");return;}
  if(!state.activeWorld){window.location.assign(adminLink.href);return;}
  document.getElementById("shutdown-world").textContent="Active world: "+state.activeWorld;
  shutdownError.textContent="";
  ensureMillwrightDialogStyle();shutdownDialog.showModal();shutdownCancel.focus();
 }catch(error){document.getElementById("world-status").textContent="Cannot open administration: "+error.message;}
});
shutdownCancel.addEventListener("click",()=>shutdownDialog.close());
shutdownDialog.addEventListener("close",()=>{if(adminLink.isConnected)adminLink.focus();});
shutdownConfirm.addEventListener("click",async()=>{
 shutdownConfirm.disabled=true;shutdownCancel.disabled=true;shutdownError.textContent="Shutting down world…";
 try{
  const response=await fetch("/millwright/api/admin/foundry/confirm-shutdown",{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"manual"});
  if(response.type==="opaqueredirect"||response.status===302){window.location.assign("/setup");return;}
  if(!response.ok){const result=await response.json().catch(()=>({}));throw Error(result.error||"HTTP "+response.status);}
  window.location.assign("/setup");
 }catch(error){shutdownError.textContent="Shutdown failed: "+error.message;shutdownConfirm.disabled=false;shutdownCancel.disabled=false;}
});
const serverStatus=document.getElementById("server-status"),worldStatus=document.getElementById("world-status"),worldStart=document.getElementById("world-start");
async function loadServerStatus(){
 try{
  const response=await fetch("/millwright/api/admin/server/status",{cache:"no-store"});
  if(!response.ok)throw Error("HTTP "+response.status);
  const data=await response.json();
  serverStatus.textContent="Millwright Service: Online · Foundry Server: "+data.foundry;
  worldStatus.textContent="Active World: "+(data.activeWorld||"None");
   joinLink.hidden=data.foundry!=="online"||!data.activeWorld;
   adminLink.hidden=data.foundry!=="online"||!data.credentialConfigured;
   setupLink.hidden=data.foundry!=="online"||data.credentialConfigured;
  worldStart.hidden=!!data.activeWorld||!data.lastWorldId||!data.credentialConfigured||data.foundry!=="online";
  if(!worldStart.hidden)worldStart.textContent="Start "+data.lastWorldId;
 }catch(error){serverStatus.textContent="Unable to check server: "+error.message;worldStart.hidden=true;joinLink.hidden=true;adminLink.hidden=true;setupLink.hidden=true;}
}
worldStart.addEventListener("click",async()=>{
 worldStart.disabled=true;worldStatus.textContent="Starting world…";
 try{
  const response=await fetch("/millwright/api/admin/world/start",{method:"POST",cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||"HTTP "+response.status);
  worldStatus.textContent="World startup requested. Waiting for Foundry…";
  setTimeout(loadServerStatus,4000);
 }catch(error){worldStatus.textContent="World startup failed: "+error.message;}
 finally{worldStart.disabled=false;}
});
loadServerStatus();
const rows=document.getElementById("sessions-rows");
const status=document.getElementById("sessions-status");
const refresh=document.getElementById("sessions-refresh");
const cleanup=document.getElementById("sessions-cleanup");
const filter=document.getElementById("sessions-filter");
let sessionInventory=[];
function date(value){return typeof value==="number"?new Date(value).toLocaleString():"—";}
async function sessionsApi(path,method="GET"){
 const response=await fetch("/millwright/api/admin/sessions"+path,{
  method,credentials:"same-origin",cache:"no-store",
  headers:method!=="GET"?{"Sec-Fetch-Site":"same-origin"}:{}
 });
 if(!response.ok){
  const data=await response.json().catch(()=>null);
  throw Error(data?.error||"HTTP "+response.status);
 }
 return response.status===204?null:response.json();
}
function renderSessions(){
 rows.replaceChildren();
 const shown=sessionInventory.filter(s=>filter.value==="all"||s.observedAt!==null).slice(0,100);
  for(const session of shown){
   const tr=document.createElement("tr");
   for(const value of [(session.discordDisplayName||session.discordUsername||session.discordUserId)+(session.discordUsername?" (@"+session.discordUsername+")":"")+" · "+session.discordUserId,session.observedFoundryUserId||"—",session.observedWorldId||"—",date(session.lastSeenAt),date(session.expiresAt)]){
    const td=document.createElement("td");td.textContent=String(value);td.style.padding=".6rem";td.style.borderBottom="1px solid #475569";tr.append(td);
   }
   const td=document.createElement("td"),button=document.createElement("button");
   button.textContent="Terminate";button.type="button";
   button.addEventListener("click",async()=>{
    if(!(await millwrightConfirm("Terminate the session for "+(session.discordDisplayName||session.discordUsername||session.discordUserId)+" ("+session.discordUserId+") and its tracked Foundry login (if any)?")))return;
    button.disabled=true;status.textContent="Terminating session…";
    try{await sessionsApi("/"+encodeURIComponent(session.sessionHandle),"DELETE");await loadSessions();status.textContent="Session terminated.";}
    catch(error){status.textContent="Termination failed: "+error.message;button.disabled=false;}
   });
   td.append(button);tr.append(td);rows.append(tr);
  }
  status.textContent=sessionInventory.length+" active Millwright sessions; "+sessionInventory.filter(s=>s.observedAt!==null).length+" with Foundry observations. Showing "+shown.length+" (maximum 100).";
}

async function loadSessions(){
 refresh.disabled=true;status.textContent="Loading sessions…";
 try{const result=await sessionsApi("");sessionInventory=result.sessions;renderSessions();}
 catch(error){status.textContent="Unable to load sessions: "+error.message;}
 finally{refresh.disabled=false;}
}
filter.addEventListener("change",renderSessions);
cleanup.addEventListener("click",async()=>{
 if(!(await millwrightConfirm("Delete all untracked Millwright-only sessions except your current session? Tracked Foundry logins will be preserved.")))return;
 cleanup.disabled=true;
 try{const result=await sessionsApi("/cleanup","POST");await loadSessions();status.textContent="Removed "+result.removed+" untracked sessions and "+result.expired+" expired sessions.";}
 catch(error){status.textContent="Cleanup failed: "+error.message;}
 finally{cleanup.disabled=false;}
});
refresh.addEventListener("click",loadSessions);loadSessions();
</script>
</body></html>`;
  });



  // Proxy only native adminConfigure writes. Preserve Foundry's response and
  // never treat a submitted credential as active until authentication succeeds.
  app.post("/api/foundry/admin-configure", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId))
      return reply.code(403).send({ error: "Administrator required" });
    const raw = request.body;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        (raw as {action?: unknown}).action !== "adminConfigure")
      return reply.code(400).send({ error: "Invalid configuration action" });
    const config = (raw as {config?: unknown}).config;
    if (!config || typeof config !== "object" || Array.isArray(config))
      return reply.code(400).send({ error: "Invalid configuration" });
    const cookie = (request.headers.cookie ?? "").split(";").map(p => p.trim())
      .find(p => /^session=[^;\s]+$/.test(p));
    if (!cookie) return reply.code(401).send({ error: "Foundry session required" });
    const upstream = await fetch("http://foundry:30000/setup", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://foundry:30000" },
      body: JSON.stringify(raw),
    });
    const body = await upstream.text();
    const type = upstream.headers.get("content-type") ?? "application/json";
    reply.code(upstream.status).header("Content-Type", type);
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) reply.header("Set-Cookie", cookies);
    if (upstream.headers.get("location")) reply.header("Location", upstream.headers.get("location")!);
    if (upstream.ok && type.includes("json")) {
      let result: {restart?: unknown; changes?: Record<string, unknown>} | null = null;
      try { result = JSON.parse(body); } catch { /* Forward malformed upstream response unchanged. */ }
      if (result && typeof result.restart === "boolean") {
        const fields = config as {adminUsername?: unknown; adminPassword?: unknown};
        const username = typeof fields.adminUsername === "string" ? fields.adminUsername.trim() : null;
        const password = typeof fields.adminPassword === "string" && fields.adminPassword.length > 0
          ? fields.adminPassword : null;
        let pending: {password: string | null; username: string | null; kind: string} | undefined;
        // Foundry does not report administrator password updates in response.changes.
        // The accepted request is authoritative for candidate credentials.
        const passwordChanged = password !== null;
        const usernameChanged = Object.prototype.hasOwnProperty.call(fields, "adminUsername")
          && username !== null;
        if ((passwordChanged || usernameChanged) && options.serviceCredentialKey) {
          const previous = getFoundryPendingState(options.database);
          const active = getFoundryServerSettings(options.database);
          const nextPassword = passwordChanged && password!.length <= 4096
            ? sealServiceCredential(password!, options.serviceCredentialKey)
            : previous.pendingPassword ?? active.encryptedPassword;
          const nextUsername = usernameChanged && username!.length <= 128
            ? username : previous.pendingKind !== "none" ? previous.pendingUsername : active.adminUsername;
          if (nextPassword && (!passwordChanged || password!.length <= 4096)
              && (!usernameChanged || username!.length <= 128)) {
            pending = {password: nextPassword, username: nextUsername ?? null, kind: "pair"};
          }
        }
        // Store only setting names, not values. Empty changes never clear
        // earlier un-restarted configuration changes.
        const changeKeys = result.changes && typeof result.changes === "object"
          && !Array.isArray(result.changes) ? Object.keys(result.changes) : [];
        if (changeKeys.length || pending) recordFoundryConfiguration(options.database, changeKeys, pending);
        if (pending) {
          // Foundry applies administrator credentials immediately, even when other
          // configuration changes require a restart. Verify with a fresh session.
          try {
            const verification = await verifyPendingCredentials();
            if (verification.status !== "promoted") {
              request.log.warn({status: verification.status}, "Foundry credential update awaiting verification");
            }
          } catch (error) {
            setFoundryPendingVerification(options.database, "unavailable");
            request.log.warn({err: error}, "Foundry credential verification unavailable after configuration");
          }
        }
      }
    }
    return reply.send(body);
  });

  async function verifyPendingCredentials() {
    const pending = getFoundryPendingState(options.database);
    const active = getFoundryServerSettings(options.database);
    if (pending.pendingKind === "none") return {status: "none"};
    if (!options.serviceCredentialKey) return {status: "unavailable"};
    const state = await fetch("http://foundry:30000/auth", {redirect:"manual",signal:AbortSignal.timeout(5000)});
    if (state.status !== 200) return {status: "unavailable"};
    const check = async (encrypted: string | null, username: string | null) => {
      if (!encrypted) return false;
      try {
        await createFoundryIntegrationSession(openServiceCredential(encrypted, options.serviceCredentialKey!), fetch, username ?? "");
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === "Foundry integration authentication rejected") return false;
        throw error;
      }
    };
    const pendingValid = await check(pending.pendingPassword, pending.pendingUsername);
    const previousValid = await check(active.encryptedPassword, active.adminUsername);
    if (pendingValid) {
      setFoundryAdminCredential(options.database, pending.pendingPassword, pending.pendingUsername);
      discardFoundryPendingCredentials(options.database);
      return {status:"promoted",pendingValid,previousValid};
    }
    const status = previousValid ? "pending-invalid-previous-valid" : "both-invalid";
    setFoundryPendingVerification(options.database, status);
    return {status,pendingValid,previousValid};
  }

  app.get("/api/admin/foundry/config-pending", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId))
      return reply.code(403).send({error:"Forbidden"});
    const state = getFoundryPendingState(options.database);
    return {restartPending: !!state.restartPending, restartRequestedAt: state.restartRequestedAt,
      restartConfirmedAt: state.restartConfirmedAt, credentialsPending: state.pendingKind !== "none",
      pendingChangeKeys: JSON.parse(state.pendingChangeKeys) as string[], verification: state.verification};
  });
  app.post("/api/admin/foundry/config-pending/verify", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId) ||
        request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({error:"Forbidden"});
    try { return await verifyPendingCredentials(); }
    catch (error) { request.log.warn({err:error},"Foundry credential verification unavailable"); return reply.code(503).send({status:"unavailable"}); }
  });
  app.post("/api/admin/foundry/config-pending/discard", async (request, reply) => {
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId) ||
        request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({error:"Forbidden"});
    discardFoundryPendingCredentials(options.database);
    return {discarded:true};
  });
  app.post("/api/admin/foundry/restart", async (request, reply) => {
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId) ||
        request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({error:"Forbidden"});
    const dir = "/var/lib/millwright-restart/";
    if (existsSync(dir + "restart-foundry.request") || existsSync(dir + "restart-foundry.processing"))
      return reply.code(409).send({error:"Restart already requested"});
    const id = randomBytes(16).toString("hex");
    const staleResult = dir + "restart-foundry.result";
    if (existsSync(staleResult)) unlinkSync(staleResult);
    try {
      writeFileSync(dir + "restart-foundry.request", JSON.stringify({id,at:Date.now()/1000}), {flag:"wx",mode:0o600});
      markFoundryRestartRequested(options.database);
      return {requested:true,id};
    } catch { return reply.code(503).send({error:"Restart helper unavailable"}); }
  });
  app.post("/api/admin/foundry/restart/confirm", async (request, reply) => {
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId) ||
        request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({error:"Forbidden"});
    const state = getFoundryPendingState(options.database);
    const file = "/var/lib/millwright-restart/restart-foundry.result";
    if (!state.restartRequestedAt || !existsSync(file)) return reply.code(409).send({error:"No completed restart"});
    try {
      const result = JSON.parse(readFileSync(file,"utf8")) as {ok:boolean;id:string};
      if (!/^[a-f0-9]{32}$/.test(result.id)) return reply.code(503).send({error:"Invalid restart result"});
      if (!result.ok) return reply.code(503).send({error:"Restart failed"});
      const response = await fetch("http://foundry:30000/auth", {redirect:"manual",signal:AbortSignal.timeout(5000)});
      if (response.status !== 200 && response.status !== 302) return reply.code(503).send({error:"Foundry not ready"});
      markFoundryRestartConfirmed(options.database);
      unlinkSync(file);
      try { return {confirmed:true,verification:await verifyPendingCredentials()}; }
      catch { return {confirmed:true,verification:{status:"unavailable"}}; }
    } catch { return reply.code(503).send({error:"Restart verification unavailable"}); }
  });

  app.get("/api/admin/foundry/credential", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const settings = getFoundryServerSettings(options.database);
    return { configured: settings.encryptedPassword !== null, adminUsername: settings.adminUsername ?? "" };
  });

  app.put("/api/admin/foundry/credential", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    const data = request.body;
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        typeof (data as { integrationSecret?: unknown }).integrationSecret !== "string" ||
        ((data as { adminUsername?: unknown }).adminUsername !== undefined &&
         typeof (data as { adminUsername?: unknown }).adminUsername !== "string")) {
      return reply.code(400).send({ error: "Administrator username and password required in valid format" });
    }
    if (!options.serviceCredentialKey) return reply.code(503).send({ error: "Credential encryption unavailable" });
    const integrationSecret = (data as { integrationSecret: string }).integrationSecret;
    const adminUsername = ((data as { adminUsername?: string }).adminUsername ?? "").trim();
    if (!integrationSecret || integrationSecret.length > 4096 || adminUsername.length > 128) {
      return reply.code(400).send({ error: "Invalid administrator credentials" });
    }
    try {
      // Verify before replacing the currently working credential pair.
      await createFoundryIntegrationSession(integrationSecret, fetch, adminUsername);
    } catch (error) {
      if (error instanceof Error && error.message === "Foundry integration authentication rejected") {
        return reply.code(422).send({ error: "Foundry rejected the administrator credentials; existing settings were preserved" });
      }
      request.log.warn({ err: error }, "Foundry administrator credential verification unavailable");
      return reply.code(503).send({ error: "Foundry administration is unavailable for credential verification; existing settings were preserved" });
    }
    setFoundryAdminCredential(options.database, sealServiceCredential(integrationSecret, options.serviceCredentialKey), adminUsername || null);
    return { configured: true, adminUsername, verified: true };
  });

  app.delete("/api/admin/foundry/credential", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    setFoundryAdminCredential(options.database, null);
    return { configured: false };
  });

  app.post("/api/admin/foundry/credential/validate", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    const settings = getFoundryServerSettings(options.database);
    if (!settings.encryptedPassword || !options.serviceCredentialKey) {
      return reply.code(409).send({ status: "unconfigured", error: "No stored administrator password" });
    }
    try {
      const state = await fetch("http://foundry:30000/auth", {
        redirect: "manual", signal: AbortSignal.timeout(5000),
      });
      if (state.status === 302 && state.headers.get("location") === "/join") {
        return { status: "unavailable", message: "A Foundry world is running. Validation is available when no world is active; the world was not interrupted." };
      }
      if (state.status !== 200) {
        return reply.code(503).send({ status: "unavailable", error: "Foundry administration authentication is unavailable" });
      }
      const password = openServiceCredential(settings.encryptedPassword, options.serviceCredentialKey);
      await createFoundryIntegrationSession(password, fetch, settings.adminUsername ?? "");
      return { status: "valid", message: "Stored administrator password accepted by Foundry." };
    } catch (error) {
      if (error instanceof Error && error.message === "Foundry integration authentication rejected") {
        return { status: "invalid", message: "Foundry rejected the stored administrator password." };
      }
      request.log.warn({ err: error }, "Foundry credential validation unavailable");
      return reply.code(503).send({ status: "unavailable", error: "Could not complete Foundry credential validation." });
    }
  });

  app.get("/admin/foundry/settings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foundry Integration Settings</title>
<style>body{font:16px system-ui,sans-serif;background:#111827;color:#f9fafb;max-width:42rem;margin:3rem auto;padding:1rem}a{color:#93c5fd}section{background:#1f2937;padding:1.5rem;border-radius:.6rem}input,button{font:inherit;padding:.5rem}input{width:100%;box-sizing:border-box;margin:.6rem 0}button{cursor:pointer}</style></head><body>
<a href="/millwright/">Dashboard</a><h1>Foundry Integration Settings</h1>
<section><p id="state" role="status" aria-live="polite">Loading…</p><p id="details"></p><p id="validation" role="status" aria-live="polite"></p>
<form id="form"><label for="admin-username">Administrator username (optional)</label><input id="admin-username" type="text" autocomplete="username" maxlength="128" placeholder="Leave blank if Foundry has no administrator username"><label id="secret-label" for="secret">Foundry server administrator password</label><input id="secret" type="password" autocomplete="new-password" required maxlength="4096">
<button id="save" type="submit">Verify &amp; Save Credentials</button> <button type="button" id="validate">Validate Credential</button> <button type="button" id="clear">Remove stored credentials</button></form>
<p>These are Foundry server administrator credentials, not a world Gamemaster account. The password is encrypted at rest and never returned to your browser. Saving requires successful authentication with Foundry; stop any active world first.</p></section>
<script>
${millwrightDialogScript}

"use strict";
const validation=document.getElementById("validation"),validate=document.getElementById("validate"),details=document.getElementById("details"),label=document.getElementById("secret-label"),save=document.getElementById("save"),state=document.getElementById("state"),form=document.getElementById("form"),secret=document.getElementById("secret"),adminUsername=document.getElementById("admin-username"),clear=document.getElementById("clear");
async function call(method,body){
 const response=await fetch("/millwright/api/admin/foundry/credential",{method,credentials:"same-origin",cache:"no-store",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(result.error||"HTTP "+response.status);
 return result;
}
async function refresh(){try{const result=await call("GET");const configured=!!result.configured;adminUsername.value=result.adminUsername||"";state.textContent=configured?"Configured — verified administrator credentials saved.":"Not configured — enter Foundry administrator credentials.";state.style.color=configured?"#86efac":"#fbbf24";state.style.fontWeight="700";details.textContent=configured?"Enter the password to verify and replace the saved credentials.":"Millwright requires valid Foundry administrator credentials for server administration.";label.textContent=configured?"Administrator password (replace)":"Administrator password";save.textContent="Verify & Save Credentials";clear.hidden=!configured;validate.hidden=!configured;}catch(error){state.textContent=error.message;}}
form.addEventListener("submit",async event=>{event.preventDefault();save.disabled=true;validation.textContent="Verifying credentials with Foundry…";try{await call("PUT",{adminUsername:adminUsername.value,integrationSecret:secret.value});secret.value="";validation.textContent="Credentials verified and saved.";validation.style.color="#86efac";await refresh();}catch(error){validation.textContent=error.message;validation.style.color="#fca5a5";}finally{save.disabled=false;}});
validate.addEventListener("click",async()=>{
 validate.disabled=true;validation.textContent="Checking stored administrator credentials against Foundry…";
 try{
  const response=await fetch("/millwright/api/admin/foundry/credential/validate",{method:"POST",credentials:"same-origin",cache:"no-store"});
  const result=await response.json().catch(()=>({}));
  validation.textContent=result.message||result.error||"Validation unavailable";
  validation.style.color=result.status==="valid"?"#86efac":result.status==="invalid"?"#fca5a5":"#fbbf24";
 }catch(error){validation.textContent="Validation unavailable: "+error.message;validation.style.color="#fbbf24";}
 finally{validate.disabled=false;}
});
clear.addEventListener("click",async()=>{if(!(await millwrightConfirm("Remove stored Foundry administrator credentials?", {title:"Remove Credentials",confirmLabel:"Remove Credentials",destructive:true})))return;try{await call("DELETE");secret.value="";await refresh();}catch(error){state.textContent=error.message;}});
refresh();
</script></body></html>`;
  });


  app.get("/api/admin/server/status", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const settings = getFoundryServerSettings(options.database);
    let online = false;
    let activeWorld: string | null = null;
    try {
      const response = await fetch("http://foundry:30000/join", {
        redirect: "manual", signal: AbortSignal.timeout(5000)
      });
      online = response.status === 200 || response.status === 302;
      if (online) {
        try {
          const inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
          activeWorld = inventory.worldId;
          rememberActiveFoundryWorld(options.database, inventory.worldId);
        } catch { /* Foundry can be online without an active world. */ }
      }
    } catch { /* Foundry unreachable. */ }
    return { middleware: "online", foundry: online ? "online" : "offline",
      activeWorld, lastWorldId: settings.lastWorldId,
      credentialConfigured: settings.encryptedPassword !== null };
  });


  app.get("/api/admin/foundry/open", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const settings = getFoundryServerSettings(options.database);
    // Initial Foundry setup must be accessible before the integration credential exists.
    if (!settings.encryptedPassword) return reply.redirect("/setup");
    // A running world must never be shut down by navigation alone.
    try {
      const response = await fetch("http://foundry:30000/auth", {
        redirect: "manual", signal: AbortSignal.timeout(5000)
      });
      if (response.status === 302 && response.headers.get("location") === "/join") {
        return reply.redirect("/millwright/admin/foundry/confirm-shutdown");
      }
      if (response.status !== 200) return reply.code(502).send({ error: "Unexpected Foundry authentication state" });
    } catch {
      return reply.code(502).send({ error: "Foundry unavailable" });
    }
    if (!options.serviceCredentialKey) return reply.code(503).send({ error: "Credential encryption unavailable" });
    try {
      const integrationSecret = openServiceCredential(settings.encryptedPassword, options.serviceCredentialKey);
      const cookie = await createFoundryIntegrationSession(integrationSecret, fetch, settings.adminUsername ?? "");
      const existing = reply.getHeader("Set-Cookie");
      reply.header("Set-Cookie", [...(existing ? (Array.isArray(existing) ? existing.map(String) : [String(existing)]) : []),
        cookie + "; Path=/; HttpOnly; Secure; SameSite=Lax"]);
      return reply.redirect("/setup");
    } catch {
      return reply.code(502).send({ error: "Foundry administration authentication failed" });
    }
  });

  app.get("/admin/foundry/confirm-shutdown", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirm Foundry World Shutdown</title><style>body{font:16px system-ui,sans-serif;background:#111827;color:#f9fafb;max-width:42rem;margin:4rem auto;padding:1rem}a{color:#93c5fd}button{font:inherit;padding:.7rem;cursor:pointer}</style></head><body>
<h1>Shut down the active Foundry world?</h1>
<p><strong>Warning:</strong> Opening Foundry server administration requires shutting down the currently running world. All connected players will be disconnected and unsaved activity may be lost.</p>
<form method="post" enctype="text/plain" action="/millwright/api/admin/foundry/confirm-shutdown"><button type="submit">Shut down world and open administration</button></form>
<p><a href="/millwright/">Cancel — keep the world running</a></p></body></html>`;
  });

  app.post("/api/admin/foundry/confirm-shutdown", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    const settings = getFoundryServerSettings(options.database);
    if (!settings.encryptedPassword || !options.serviceCredentialKey) {
      return reply.code(409).send({ error: "Foundry integration credential required" });
    }
    try {
      const state = await fetch("http://foundry:30000/auth", {
        redirect: "manual", signal: AbortSignal.timeout(5000)
      });
      if (state.status === 200) return reply.redirect("/millwright/api/admin/foundry/open");
      if (state.status !== 302 || state.headers.get("location") !== "/join") {
        return reply.code(502).send({ error: "Unexpected Foundry world state" });
      }
      const integrationSecret = openServiceCredential(settings.encryptedPassword, options.serviceCredentialKey);
      const cookie = await shutdownFoundryWorldForAdministration(integrationSecret, fetch, settings.adminUsername ?? "");
      const existing = reply.getHeader("Set-Cookie");
      reply.header("Set-Cookie", [...(existing ? (Array.isArray(existing) ? existing.map(String) : [String(existing)]) : []),
        cookie + "; Path=/; HttpOnly; Secure; SameSite=Lax"]);
      return reply.redirect("/setup");
    } catch (error) {
      request.log.error({ err: error }, "Foundry world shutdown failed");
      return reply.code(502).send({ error: "Foundry world shutdown or authentication failed" });
    }
  });

  app.post("/api/admin/world/start", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    const settings = getFoundryServerSettings(options.database);
    if (!settings.encryptedPassword || !settings.lastWorldId || !options.serviceCredentialKey) {
      return reply.code(409).send({ error: "Integration credential and remembered world required" });
    }
    try {
      const integrationSecret = openServiceCredential(settings.encryptedPassword, options.serviceCredentialKey);
      const cookie = await createFoundryIntegrationSession(integrationSecret, fetch, settings.adminUsername ?? "");
      const response = await fetch("http://foundry:30000/setup", {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://foundry:30000" },
        body: JSON.stringify({ world: settings.lastWorldId, action: "launchWorld" })
      });
      if (!response.ok) return reply.code(502).send({ error: "Foundry rejected world startup" });
      return reply.code(202).send({ starting: true, worldId: settings.lastWorldId });
    } catch {
      return reply.code(502).send({ error: "Foundry world startup failed" });
    }
  });

  app.get("/admin/mappings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("text/html; charset=utf-8");
    return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Millwright — Account Mappings</title>\n<style>body{font:16px system-ui;background:#111827;color:#f9fafb;max-width:75rem;margin:2rem auto;padding:1rem}a{color:#93c5fd}button,select{font:inherit;padding:.5rem;border-radius:.3rem}button{cursor:pointer;background:#93c5fd;border:0}button:disabled{opacity:.5}table{border-collapse:collapse;width:100%}th,td{padding:.75rem;text-align:left;border-bottom:1px solid #475569}select{max-width:24rem}#status{white-space:pre-wrap;padding:1rem;background:#1f2937}td button{margin:.2rem}dialog{color:#f9fafb;background:#1f2937;border:1px solid #475569;border-radius:.65rem;box-shadow:0 20px 60px #0009;padding:1.5rem;max-width:min(90vw,28rem)}dialog::backdrop{background:#000a}dialog form{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:flex-end}dialog p{flex-basis:100%;margin:0 0 .75rem;line-height:1.5}dialog button{min-width:6rem}dialog button[value=cancel]{background:#374151;color:#f9fafb;border:1px solid #64748b}dialog button[value=confirm]{background:#93c5fd;color:#111827}</style></head>\n<body><a href=\"/millwright/\">Dashboard</a><h1>Foundry Account Mappings</h1><p>Manage Discord associations for the active Foundry world.</p>\n<button id=\"refresh\">Refresh</button> <button id=\"sync\">Synchronize Foundry accounts</button><p id=\"status\" role=\"status\" aria-live=\"polite\">Loading…</p>\n<div style=\"overflow-x:auto\"><table><thead><tr><th>Foundry account</th><th>Role</th><th>Discord identity</th><th>Actions</th></tr></thead><tbody id=\"rows\"></tbody></table></div>\n<script>\n\n\"use strict\";\n" + millwrightDialogScript + "\nconst rows=document.getElementById(\"rows\"),status=document.getElementById(\"status\");\nlet worldId,accounts=[],members=[],mappings=[],serviceAccountUserId=null;\nfunction message(value){status.textContent=value;}\nasync function api(path,init={}){\n const response=await fetch(\"/millwright/api\"+path,{credentials:\"same-origin\",cache:\"no-store\",...init});\n const data=response.status===204?null:await response.json().catch(()=>null);\n if(!response.ok)throw Error(data&&data.error||\"HTTP \"+response.status);\n return data;\n}\nfunction mappingPath(id){return \"/worlds/\"+encodeURIComponent(worldId)+\"/accounts/\"+encodeURIComponent(id)+\"/mapping\";}\nfunction render(){\n rows.replaceChildren();\n for(const account of accounts){if(account.id===serviceAccountUserId)continue;\n  const existing=mappings.find(m=>m.foundryUserId===account.id);\n  const tr=document.createElement(\"tr\"),name=document.createElement(\"td\"),role=document.createElement(\"td\"),association=document.createElement(\"td\"),actions=document.createElement(\"td\");\n  name.textContent=account.name;\n  role.textContent=({1:\"Player\",2:\"Trusted Player\",3:\"Assistant GM\",4:\"Gamemaster\"})[account.role]||\"None\";\n  const select=document.createElement(\"select\");\n  select.setAttribute(\"aria-label\",\"Discord identity for \"+account.name);\n  const empty=document.createElement(\"option\");empty.value=\"\";empty.textContent=\"Select Discord member…\";select.append(empty);\n  for(const member of members){\n   const opt=document.createElement(\"option\");opt.value=member.id;\n   opt.textContent=(member.displayName||member.globalName||member.username)+\" (\"+member.username+\", \"+member.id+\")\";\n   if(mappings.some(m=>m.discordUserId===member.id&&m.foundryUserId!==account.id)){opt.disabled=true;opt.textContent+=\" — assigned\";}\n   select.append(opt);\n  }\n  if(existing&&!members.some(m=>m.id===existing.discordUserId)){\n   const unknown=document.createElement(\"option\");unknown.value=existing.discordUserId;unknown.textContent=\"Unknown Discord identity (\"+existing.discordUserId+\")\";select.append(unknown);\n  }\n  select.value=existing?existing.discordUserId:\"\";\n  association.append(select);\n  const remove=document.createElement(\"button\");remove.textContent=\"Unlink\";remove.disabled=!existing;\n  select.addEventListener(\"change\",async()=>{\n   const original=existing?existing.discordUserId:\"\";\n   const selected=select.value;\n   if(selected===original)return;\n   if(!selected){select.value=original;return;}\n   if(!(await millwrightConfirm((existing?\"Change\":\"Link\")+\" the Discord identity for \"+account.name+\"?\", {title:existing?\"Change Discord Identity\":\"Link Discord Identity\",confirmLabel:existing?\"Change Identity\":\"Link Identity\"}))){select.value=original;return;}\n   select.disabled=true;remove.disabled=true;\n   try{\n    await api(mappingPath(account.id),{method:existing?\"PATCH\":\"PUT\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({discordUserId:selected})});\n    await load();message(\"Saved association for \"+account.name);\n   }catch(error){select.value=original;select.disabled=false;remove.disabled=!existing;message(\"Error: \"+error.message);}\n  });\n  remove.addEventListener(\"click\",async()=>{\n   if(!(await millwrightConfirm(\"Unlink the Discord identity from \"+account.name+\"?\", {title:\"Unlink Discord Identity\",confirmLabel:\"Unlink\",destructive:true})))return;\n   remove.disabled=true;\n   try{await api(mappingPath(account.id),{method:\"DELETE\"});await load();message(\"Unlinked Discord identity from \"+account.name);}\n   catch(error){message(error.message);remove.disabled=false;}\n  });\n  actions.append(remove);tr.append(name,role,association,actions);rows.append(tr);\n }\n}\nasync function load(){\n document.getElementById(\"refresh\").disabled=true;\n try{\n  const foundry=await api(\"/foundry/accounts\");\n  worldId=foundry.worldId;accounts=foundry.accounts;serviceAccountUserId=foundry.serviceAccountUserId||null;\n  const [saved,discord]=await Promise.all([api(\"/worlds/\"+encodeURIComponent(worldId)+\"/mappings\"),api(\"/discord/members?limit=100\")]);\n  if(discord.nextAfter)throw Error(\"Discord member list is paginated; cannot edit until all members are loaded.\");\n  mappings=saved.mappings;members=discord.members;\n  render();message(\"World: \"+worldId+\" — \"+accounts.length+\" Foundry accounts, \"+mappings.length+\" mappings\");\n }catch(error){rows.replaceChildren();message(\"Error: \"+error.message);}\n finally{document.getElementById(\"refresh\").disabled=false;}\n}\ndocument.getElementById(\"refresh\").addEventListener(\"click\",load);\ndocument.getElementById(\"sync\").addEventListener(\"click\",async()=>{\n if(!(await millwrightConfirm(\"Synchronize Foundry accounts? Removed accounts will lose their mappings.\", {title:\"Synchronize Foundry Accounts\",confirmLabel:\"Synchronize\",destructive:true})))return;\n const button=document.getElementById(\"sync\");button.disabled=true;\n try{\n  const result=await api(\"/foundry/accounts/sync\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:\"{}\"});\n  await load();message(\"Synchronized \"+result.registered+\" accounts; removed \"+result.removed+\".\");\n }catch(error){message(\"Error: \"+error.message);}finally{button.disabled=false;}\n});\nload();\n</script></body></html>";
  });

  app.get("/admin/bootstrap", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Millwright Administrator Setup</title><style>
body{font:16px system-ui,sans-serif;background:#111827;color:#f9fafb;max-width:36rem;margin:5rem auto;padding:1rem}
input,button{font:inherit;padding:.7rem;border-radius:.35rem}input{box-sizing:border-box;width:100%;margin:1rem 0;background:#fff;color:#111}
button{background:#93c5fd;border:0;cursor:pointer}#message{margin-top:1rem}a{color:#93c5fd}
</style></head><body><h1>Millwright Administrator Setup</h1>
<p>The bootstrap challenge is displayed in the PowerShell console when Millwright starts. Copy the challenge from that console and enter it below.</p>\n<p>If the console was closed, open PowerShell on the Millwright host, navigate to the Millwright repository directory, and run <code>.\scripts\\Start-Millwright.ps1</code> to display the challenge again.</p>\n<p>The challenge is valid only until the first administrator successfully claims the role.</p>
<form id="claim"><label for="challenge">Bootstrap challenge</label>
<input id="challenge" type="password" autocomplete="off" required pattern="[a-f0-9]{64}" maxlength="64">
<button type="submit">Claim administrator role</button></form><p id="message" role="status" aria-live="polite"></p>
<script>


const form=document.getElementById('claim'), message=document.getElementById('message');
async function status(){
 try {
  const r=await fetch('../api/admin/status',{credentials:'same-origin',cache:'no-store'});
  if(!r.ok)throw Error('Unable to check administrator status.');
  const data=await r.json();
  if(data.bootstrapComplete){
   form.hidden=true;
   message.textContent=data.administrator?'Administrator registration complete. Redirecting to dashboard…':'Administrator registration is already complete.';\n    if(data.administrator)window.location.replace('/millwright/');
  }
 }catch(e){message.textContent=e.message;}
}
form.addEventListener('submit',async event=>{
 event.preventDefault();
 const challenge=document.getElementById('challenge').value;
 document.getElementById('challenge').value='';
 message.textContent='Validating…';
 try{
  const r=await fetch('../api/admin/bootstrap',{method:'POST',credentials:'same-origin',
   headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge})});
  const data=await r.json();
  if(!r.ok)throw Error(data.error||'Registration failed.');
  await status();
 }catch(e){message.textContent=e.message;}
});
status();
</script></body></html>`;
  });

  app.get("/api/admin/status", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      bootstrapComplete: isAdministratorBootstrapComplete(options.database),
      administrator: !!request.discordIdentity &&
        isMillwrightAdministrator(options.database, request.discordIdentity.userId),
    };
  });

  app.post<{ Body: { challenge: string } }>("/api/admin/bootstrap", {
    schema: {
      body: { type: "object", additionalProperties: false, required: ["challenge"],
        properties: { challenge: { type: "string", pattern: "^[a-f0-9]{64}$" } } }
    }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    if (!request.discordIdentity) return reply.code(401).send({ error: "Unauthorized" });
    if (isAdministratorBootstrapComplete(options.database)) {
      return reply.code(409).send({ error: "Bootstrap already completed" });
    }
    if (!expectedChallengeHash) return reply.code(503).send({ error: "Bootstrap is not configured" });
    const suppliedHash = createHash("sha256").update(request.body.challenge).digest();
    if (!timingSafeEqual(suppliedHash, expectedChallengeHash)) {
      return reply.code(403).send({ error: "Invalid bootstrap challenge" });
    }
    const claimed = claimInitialAdministrator(options.database, request.discordIdentity.userId);
    if (!claimed) return reply.code(409).send({ error: "Bootstrap already completed" });
    return { administrator: true, bootstrapComplete: true };
  });

  // Read-only Discord member discovery for administrator-driven Foundry onboarding.
  app.get<{ Querystring: { limit?: number; after?: string } }>("/api/discord/members", {
    schema: {
      querystring: {
        type: "object", additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          after: { type: "string", pattern: "^[0-9]{17,20}$" },
        },
      },
    },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (!options.discordGuildId || !options.discordBotToken) {
      return reply.code(503).send({ error: "Discord member discovery is not configured" });
    }
    try {
      return await listGuildMembers(
        options.discordGuildId,
        options.discordBotToken,
        request.query.limit ?? 100,
        request.query.after,
      );
    } catch (error) {
      request.log.warn({ err: error }, "Discord member discovery failed");
      return reply.code(502).send({ error: "Discord member discovery unavailable" });
    }
  });

  // Administrator-only session inventory. Handles are hashes, not bearer credentials.
  app.get("/api/admin/sessions", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    purgeExpiredSessions(options.database);
    const sessions = listActiveSessions(options.database);
    if (options.discordGuildId && options.discordBotToken) {
      const stale = sessions.filter(session =>
        typeof session.discordNameSyncedAt !== "number" ||
        Date.now() - session.discordNameSyncedAt > 15 * 60 * 1000);
      const ids = [...new Set(stale.map(session => session.discordUserId))];
      for (const userId of ids.slice(0, 20)) {
        try {
          const response = await fetch(
            `https://discord.com/api/v10/guilds/${options.discordGuildId}/members/${userId}`,
            { headers: { Authorization: `Bot ${options.discordBotToken}` },
              signal: AbortSignal.timeout(4000) }
          );
          if (!response.ok) continue;
          const member = await response.json() as {
            nick?: string | null;
            user?: { username?: string; global_name?: string | null };
          };
          const username = member.user?.username;
          if (username) updateDiscordIdentityName(options.database, userId,
            username, member.nick || member.user?.global_name || username);
        } catch (error) {
          request.log.warn({ err: error }, "Discord session name lookup failed");
        }
      }
    }
    return { sessions: listActiveSessions(options.database) };
  });

  // Development cleanup: remove authentication-only records, not managed Foundry logins.
  app.post("/api/admin/sessions/cleanup", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin" || !request.millwrightSessionId) {
      return reply.code(403).send({ error: "Same-origin session required" });
    }
    const expired = purgeExpiredSessions(options.database);
    const removed = purgeUnmanagedSessions(options.database, request.millwrightSessionId);
    return { expired, removed };
  });

  app.delete<{ Params: { handle: string } }>("/api/admin/sessions/:handle", {
    schema: { params: { type: "object", required: ["handle"], additionalProperties: false,
      properties: { handle: { type: "string", pattern: "^[a-f0-9]{64}$" } } } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    const managed = getManagedFoundrySessionByHandle(options.database, request.params.handle);
    if (managed) {
      if (!options.serviceCredentialKey) {
        return reply.code(503).send({ error: "Session termination unavailable" });
      }
      try {
        await terminateFoundrySession(openServiceCredential(managed.encryptedCookie, options.serviceCredentialKey));
      } catch {
        return reply.code(502).send({ error: "Foundry session termination failed" });
      }
    }
    if (!revokeSessionByHandle(options.database, request.params.handle)) {
      return reply.code(404).send({ error: "Active session not found" });
    }
    return reply.code(204).send();
  });

  // Read-only world mapping inventory. Never authorize from client-observed Foundry roles.
  app.get<{ Params: { worldId: string } }>("/api/worlds/:worldId/mappings", {
    schema: {
      params: { type: "object", required: ["worldId"], additionalProperties: false,
        properties: { worldId: { type: "string", minLength: 1, maxLength: 128 } } }
    }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    return { mappings: getAccountMappingsForWorld(options.database, request.params.worldId) };
  });

  // Administrator-controlled mapping. Both IDs are server-side constrained:
  // Foundry account must already exist in the reconciled world inventory.
  app.put<{ Params: { worldId: string; foundryUserId: string }; Body: { discordUserId: string } }>(
    "/api/worlds/:worldId/accounts/:foundryUserId/mapping", {
      schema: {
        params: { type: "object", required: ["worldId", "foundryUserId"],
          additionalProperties: false, properties: {
            worldId: { type: "string", minLength: 1, maxLength: 128 },
            foundryUserId: { type: "string", minLength: 1, maxLength: 128 },
          } },
        body: { type: "object", required: ["discordUserId"], additionalProperties: false,
          properties: { discordUserId: { type: "string", pattern: "^[0-9]{17,20}$" } } },
      },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.discordIdentity ||
          !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (request.headers["sec-fetch-site"] !== "same-origin") {
        return reply.code(403).send({ error: "Same-origin request required" });
      }
      const { worldId, foundryUserId } = request.params;
      const { discordUserId } = request.body;
      if (getStoredServiceCredential(options.database, worldId)?.foundryUserId === foundryUserId) {
        return reply.code(403).send({ error: "Millwright service account cannot be mapped" });
      }
      const exists = options.database.prepare(
        "SELECT 1 FROM foundry_accounts WHERE world_id = ? AND foundry_user_id = ?"
      ).get(worldId, foundryUserId);
      if (!exists) return reply.code(404).send({ error: "Foundry account not synchronized" });
      const current = getMappingByFoundryAccount(options.database, worldId, foundryUserId);
      if (current?.discordUserId === discordUserId) return { mapping: current };
      if (current) return reply.code(409).send({ error: "Foundry account already mapped" });
      if (getAccountMapping(options.database, worldId, discordUserId)) {
        return reply.code(409).send({ error: "Discord account already mapped in world" });
      }
      try {
        // Identity registration is not authorization; it only establishes the FK.
        registerDiscordIdentity(options.database, discordUserId);
        createAccountMapping(options.database, { worldId, foundryUserId, discordUserId });
        return reply.code(201).send({ mapping: { worldId, foundryUserId, discordUserId } });
      } catch {
        return reply.code(409).send({ error: "Account mapping conflict" });
      }
    }
  );

  app.patch<{ Params: { worldId: string; foundryUserId: string }; Body: { discordUserId: string } }>(
    "/api/worlds/:worldId/accounts/:foundryUserId/mapping", {
      schema: {
        params: { type: "object", required: ["worldId", "foundryUserId"],
          additionalProperties: false, properties: {
            worldId: { type: "string", minLength: 1, maxLength: 128 },
            foundryUserId: { type: "string", minLength: 1, maxLength: 128 },
          } },
        body: { type: "object", required: ["discordUserId"], additionalProperties: false,
          properties: { discordUserId: { type: "string", pattern: "^[0-9]{17,20}$" } } },
      },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.discordIdentity ||
          !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (request.headers["sec-fetch-site"] !== "same-origin") {
        return reply.code(403).send({ error: "Same-origin request required" });
      }
      const { worldId, foundryUserId } = request.params;
      const { discordUserId } = request.body;
      if (getStoredServiceCredential(options.database, worldId)?.foundryUserId === foundryUserId) {
        return reply.code(403).send({ error: "Millwright service account cannot be mapped" });
      }
      try {
        const result = updateAccountMapping(options.database, worldId, foundryUserId, discordUserId);
        if (result === "missing") return reply.code(404).send({ error: "Account mapping not found" });
        if (result === "conflict") return reply.code(409).send({ error: "Discord account already mapped in world" });
        return { mapping: { worldId, foundryUserId, discordUserId } };
      } catch {
        return reply.code(500).send({ error: "Account mapping update failed" });
      }
    }
  );

  app.delete<{ Params: { worldId: string; foundryUserId: string } }>(
    "/api/worlds/:worldId/accounts/:foundryUserId/mapping", {
      schema: { params: { type: "object", required: ["worldId", "foundryUserId"],
        additionalProperties: false, properties: {
          worldId: { type: "string", minLength: 1, maxLength: 128 },
          foundryUserId: { type: "string", minLength: 1, maxLength: 128 },
        } } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.discordIdentity ||
          !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (request.headers["sec-fetch-site"] !== "same-origin") {
        return reply.code(403).send({ error: "Same-origin request required" });
      }
      if (!removeAccountMapping(options.database, request.params.worldId, request.params.foundryUserId)) {
        return reply.code(404).send({ error: "Account mapping not found" });
      }
      return reply.code(204).send();
    }
  );

  // Server-derived, read-only account inventory. No client-supplied Foundry URL or world ID.
  app.get("/api/foundry/accounts", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    try {
      const inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
      const serviceAccountUserId = getStoredServiceCredential(options.database, inventory.worldId)?.foundryUserId ?? null;
      return { ...inventory, serviceAccountUserId };
    } catch {
      // Never log join-data payloads or transport credentials.
      return reply.code(502).send({ error: "Foundry account discovery unavailable" });
    }
  });

  // Explicit administrator action: discover first, then reconcile atomically.
  app.post("/api/foundry/accounts/sync", {
    schema: { body: { type: "object", additionalProperties: false, maxProperties: 0 } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity ||
        !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    let inventory;
    try {
      inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
    } catch {
      return reply.code(502).send({ error: "Foundry account discovery unavailable" });
    }
    // Fail closed on invalid, duplicate, or empty inventories. An empty response
    // must never accidentally cascade-delete existing account mappings.
    if (!inventory || typeof inventory.worldId !== "string" ||
        !inventory.worldId || inventory.worldId.length > 128 ||
        !Array.isArray(inventory.accounts) || inventory.accounts.length === 0 ||
        inventory.accounts.length > 10000 ||
        inventory.accounts.some(account =>
          !account || typeof account.id !== "string" || !account.id ||
          account.id.length > 128 || typeof account.name !== "string" ||
          !account.name || !Number.isInteger(account.role) ||
          account.role < 0 || account.role > 4) ||
        new Set(inventory.accounts.map(account => account.id)).size !== inventory.accounts.length) {
      return reply.code(502).send({ error: "Invalid Foundry account inventory" });
    }
    try {
      const result = reconcileFoundryAccounts(
        options.database, inventory.worldId, inventory.accounts.map(account => account.id));
      saveFoundryPlayerMetadata(options.database, inventory.worldId, inventory.accounts);
      rememberActiveFoundryWorld(options.database, inventory.worldId);
      return { worldId: inventory.worldId, ...result };
    } catch {
      return reply.code(500).send({ error: "Foundry account reconciliation failed" });
    }
  });

  // Administrator-only service-account provisioning. Credentials are returned
  // solely to the authenticated administrator's same-origin module request.
  // Responses must never be cached or logged.
  app.post<{ Params: { worldId: string }; Body: Record<string, never> }>(
    "/api/worlds/:worldId/service-account/prepare", {
      schema: {
        params: { type: "object", required: ["worldId"], additionalProperties: false,
          properties: { worldId: { type: "string", minLength: 1, maxLength: 128 } } },
        body: { type: "object", additionalProperties: false, maxProperties: 0 },
      },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.discordIdentity ||
          !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (request.headers["sec-fetch-site"] !== "same-origin") {
        return reply.code(403).send({ error: "Same-origin request required" });
      }
      if (!options.serviceCredentialKey) return reply.code(503).send({ error: "Service provisioning unavailable" });
      let inventory;
      try {
        inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
      } catch {
        return reply.code(502).send({ error: "Foundry world discovery unavailable" });
      }
      if (inventory.worldId !== request.params.worldId) {
        return reply.code(409).send({ error: "Active Foundry world does not match" });
      }
      if (getStoredServiceCredential(options.database, request.params.worldId)) {
        return reply.code(409).send({ error: "Service account already provisioned" });
      }
      try {
        const prepared = prepareServiceProvisioning(
          options.database, options.serviceCredentialKey, request.params.worldId);
        return { worldId: request.params.worldId, username: "Millwright",
          password: prepared.password, resumed: prepared.resumed };
      } catch {
        return reply.code(409).send({ error: "Service provisioning preparation failed" });
      }
    });

  app.post<{ Params: { worldId: string }; Body: { foundryUserId: string } }>(
    "/api/worlds/:worldId/service-account/complete", {
      schema: {
        params: { type: "object", required: ["worldId"], additionalProperties: false,
          properties: { worldId: { type: "string", minLength: 1, maxLength: 128 } } },
        body: { type: "object", required: ["foundryUserId"], additionalProperties: false,
          properties: { foundryUserId: { type: "string", minLength: 1, maxLength: 128 } } },
      },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.discordIdentity ||
          !isMillwrightAdministrator(options.database, request.discordIdentity.userId)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (request.headers["sec-fetch-site"] !== "same-origin") {
        return reply.code(403).send({ error: "Same-origin request required" });
      }
      if (!options.serviceCredentialKey) return reply.code(503).send({ error: "Service provisioning unavailable" });
      let inventory;
      try {
        inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
      } catch {
        return reply.code(502).send({ error: "Foundry world discovery unavailable" });
      }
      if (inventory.worldId !== request.params.worldId) {
        return reply.code(409).send({ error: "Active Foundry world does not match" });
      }
      try {
        const status = await completeServiceProvisioning(
          options.database, options.serviceCredentialKey, request.params.worldId,
          request.body.foundryUserId, options.serviceAccountVerifier ?? verifyFoundryServiceAccount);
        return { worldId: request.params.worldId, status };
      } catch {
        return reply.code(409).send({ error: "Service provisioning completion failed" });
      }
    });

  // Issue a Foundry session only for the account mapped to the authenticated
  // Discord identity in the currently active world. Never accept a target ID.
  app.get("/api/autologin", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity) return reply.code(401).send({ error: "Unauthorized" });
    if (!options.serviceCredentialKey) {
      return reply.code(503).send({ error: "Autologin is not configured" });
    }
    let inventory;
    try {
      inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
    } catch {
      return reply.code(503).send({ error: "No active Foundry world" });
    }
    const mapping = getAccountMapping(options.database, inventory.worldId, request.discordIdentity.userId);
    if (!mapping || !inventory.accounts.some(account => account.id === mapping.foundryUserId)) {
      return reply.code(403).send({ error: "No valid Foundry account mapping" });
    }
    const credential = getStoredServiceCredential(options.database, inventory.worldId);
    if (!credential || mapping.foundryUserId === credential.foundryUserId) {
      return reply.code(503).send({ error: "Foundry autologin unavailable" });
    }
    try {
      const cookie = await createFoundryAutologinSession({
        serviceUserId: credential.foundryUserId,
        encryptedPassword: credential.encryptedPassword,
        credentialKey: options.serviceCredentialKey,
        targetUserId: mapping.foundryUserId,
      });
      if (!request.millwrightSessionId) throw new Error("Missing Millwright session");
      storeManagedFoundrySession(options.database, {
        millwrightSessionId: request.millwrightSessionId,
        worldId: inventory.worldId,
        foundryUserId: mapping.foundryUserId,
        encryptedCookie: sealServiceCredential(cookie, options.serviceCredentialKey),
      });
      // Foundry uses a root-scoped session cookie; replace any prior browser
      // session only after loginAs has succeeded.
      reply.header("Set-Cookie", cookie + "; Path=/; HttpOnly; Secure; SameSite=Lax");
      return reply.redirect("/game");
    } catch {
      return reply.code(502).send({ error: "Foundry autologin failed" });
    }
  });


  // Browser login controls are only rendered for users authenticated by Caddy.
  app.get("/api/foundry-login-actions", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    const admin = isMillwrightAdministrator(options.database, identity.userId);
    const settings = getFoundryServerSettings(options.database);
    const row = options.database.prepare(
      "SELECT display_name AS displayName, username FROM discord_identities WHERE discord_user_id = ?"
    ).get(identity.userId) as { displayName?: string | null; username?: string | null } | undefined;
    let player = false;
    try {
      const inventory = await (options.foundryDiscovery ?? discoverFoundryAccounts)();
      const mapping = getAccountMapping(options.database, inventory.worldId, identity.userId);
      const service = getStoredServiceCredential(options.database, inventory.worldId);
      player = Boolean(options.serviceCredentialKey && mapping && service &&
        mapping.foundryUserId !== service.foundryUserId &&
        inventory.accounts.some(account => account.id === mapping.foundryUserId));
    } catch { /* No active world or discovery unavailable. */ }
    return {
      displayName: row?.displayName || row?.username || identity.userId,
      player,
      administrator: admin && Boolean(settings.encryptedPassword && options.serviceCredentialKey)
    };
  });

  // Only GET HTML pages are rewritten. Foundry POSTs and other routes stay direct.
  app.get("/api/foundry-login-page", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const page = request.headers["x-millwright-page"];
    if (page !== "/join" && page !== "/auth") return reply.code(400).send({ error: "Invalid page" });
    const incomingCookie = request.headers.cookie ?? "";
    const foundrySession = incomingCookie.split(";").map(part => part.trim())
      .find(part => /^session=[^;\s]+$/.test(part));
    const upstream = await fetch("http://foundry:30000" + page, {
      redirect: "manual", signal: AbortSignal.timeout(10000),
      headers: foundrySession ? { Cookie: foundrySession, "Accept": "text/html" } : { Accept: "text/html" }
    });
    const location = upstream.headers.get("location");
    if (location && upstream.status >= 300 && upstream.status < 400) {
      return reply.code(upstream.status).header("Location", location).send();
    }
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.includes("text/html")) {
      return reply.code(upstream.status).send(await upstream.text());
    }
    const html = await upstream.text();
    const injected = html.replace(/<\/body\s*>/i,
      '<script src="/millwright/api/foundry-login-script" defer></script></body>');
    reply.code(upstream.status).type("text/html; charset=utf-8");
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) reply.header("Set-Cookie", cookies);
    // The injected script is served from the same origin; retain Foundry's own
    // response framing and other policies, but do not forward stale length/encoding.
    const csp = upstream.headers.get("content-security-policy");
    if (csp) reply.header("Content-Security-Policy", csp);
    return injected;
  });


  app.get("/api/foundry-setup-script", async (_request, reply) => {
    reply.header("Cache-Control","no-store").type("application/javascript; charset=utf-8");
    return `(() => {
      if (location.pathname !== "/setup") return;
      const originalFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        try {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
          if (url.origin === location.origin && url.pathname === "/setup" && method === "POST") {
            const body = init?.body;
            if (typeof body === "string") {
              const data = JSON.parse(body);
              if (data?.action === "adminConfigure") {
                return originalFetch("/millwright/api/foundry/admin-configure", {
                  ...init, method:"POST", credentials:"same-origin",
                  headers: (() => { const headers = new Headers(init?.headers); headers.set("Content-Type","application/json"); return headers; })(),
                  body
                });
              }
            }
          }
        } catch { /* Native request proceeds unchanged. */ }
        return originalFetch(input, init);
      };
      const style=document.createElement("style");
      style.textContent="#millwright-dashboard-button,#millwright-restart-button{color:#74d8c4;border-color:#49bda8} #millwright-dashboard-button:hover,#millwright-restart-button:hover{color:#fff;background:rgba(15,61,63,.85)} #millwright-restart-button{position:relative} #millwright-restart-button .millwright-pending-mark{display:none;position:absolute;top:-5px;right:-5px;font-size:11px;color:#e4ae4d;text-shadow:0 1px 2px #000} #millwright-restart-button.millwright-restart-pending .millwright-pending-mark{display:block}";
      document.head.append(style);
      const dashboard=document.createElement("button");
      dashboard.type="button";dashboard.id="millwright-dashboard-button";dashboard.className="icon";
      dashboard.setAttribute("data-tooltip","");dashboard.setAttribute("aria-label","Millwright Dashboard");
      const dashboardIcon=document.createElement("i");dashboardIcon.className="fa-solid fa-gauge-high";dashboard.append(dashboardIcon);
      dashboard.addEventListener("click",()=>{location.href="/millwright/"});
      const restart=document.createElement("button");
      restart.type="button";restart.id="millwright-restart-button";restart.className="icon";
      restart.setAttribute("data-tooltip","");restart.setAttribute("aria-label","Restart Foundry Server");
      const restartIcon=document.createElement("i");restartIcon.className="fa-solid fa-rotate";
      const pendingMark=document.createElement("i");pendingMark.className="fa-solid fa-circle-exclamation millwright-pending-mark";
      pendingMark.setAttribute("aria-hidden","true");restart.append(restartIcon,pendingMark);
      restart.addEventListener("click",async()=>{
        const DialogV2=globalThis.foundry?.applications?.api?.DialogV2;
        if(!DialogV2){
          console.error("Millwright: Foundry DialogV2 unavailable on setup page");
          return;
        }
        const confirmed=await DialogV2.confirm({
          window:{title:"Restart Foundry Server"},
          content:"<p>Restart the Foundry server?</p><p>All connected users will be disconnected.</p>",
          yes:{label:"Restart Server",icon:"fa-solid fa-rotate"},
          no:{label:"Cancel"},
          rejectClose:false,
          modal:true
        });
        if(confirmed!==true)return;
        restart.disabled=true;
        try{
          const response=await originalFetch("/millwright/api/admin/foundry/restart",{method:"POST",credentials:"same-origin"});
          if(!response.ok)throw Error((await response.json()).error || "Restart unavailable");
          restart.setAttribute("aria-label","Restart requested — check Millwright Dashboard");
        }catch(error){console.error("Millwright: Foundry restart failed",error);await DialogV2.prompt({window:{title:"Foundry Restart Failed"},content:"<p>Foundry restart failed. Check the Millwright Dashboard for details.</p>",ok:{label:"Close"},rejectClose:false,modal:true});restart.disabled=false}
      });
      async function refreshPending(){
        try{
          const response=await originalFetch("/millwright/api/admin/foundry/config-pending",{credentials:"same-origin",cache:"no-store"});
          if(!response.ok)return;
          const state=await response.json();
          restart.classList.toggle("millwright-restart-pending",!!state.restartPending);
          if(!restart.disabled)restart.setAttribute("aria-label",state.restartPending?"Changes Pending Reboot":"Restart Foundry Server");
        }catch{ /* Keep controls usable when status is unavailable. */ }
      }
      function attachButtons(){
        const toolbar=document.querySelector("#setup-menu-buttons");
        if(!toolbar)return false;
        if(!dashboard.isConnected)toolbar.append(dashboard);
        if(!restart.isConnected)toolbar.append(restart);
        return true;
      }
      if(!attachButtons()){
        const observer=new MutationObserver(()=>{if(attachButtons())observer.disconnect()});
        observer.observe(document.body,{childList:true,subtree:true});
        setTimeout(()=>observer.disconnect(),15000);
      }
      refreshPending();
    })();`;
  });

  app.get("/api/foundry-setup-page", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.discordIdentity || !isMillwrightAdministrator(options.database, request.discordIdentity.userId))
      return reply.code(403).send({error:"Forbidden"});
    const cookie = (request.headers.cookie ?? "").split(";").map(p=>p.trim()).find(p=>/^session=[^;\s]+$/.test(p));
    const upstream = await fetch("http://foundry:30000/setup", {
      redirect:"manual", signal:AbortSignal.timeout(10000),
      headers: cookie ? {Cookie:cookie,Accept:"text/html"} : {Accept:"text/html"}
    });
    const location=upstream.headers.get("location");
    if (location && upstream.status >= 300 && upstream.status < 400)
      return reply.code(upstream.status).header("Location",location).send();
    const type=upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.includes("text/html")) return reply.code(upstream.status).send(await upstream.text());
    const html=(await upstream.text()).replace("</body>",
      '<script src="/millwright/api/foundry-setup-script"></script></body>');
    const cookies=upstream.headers.getSetCookie();
    if(cookies.length)reply.header("Set-Cookie",cookies);
    const csp=upstream.headers.get("content-security-policy");
    if(csp)reply.header("Content-Security-Policy",csp);
    return reply.code(upstream.status).type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/foundry-login-script", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("application/javascript; charset=utf-8");
    return `(async()=> {
      if (!["/join","/auth"].includes(location.pathname)) return;
      let actions;
      try {
        const response=await fetch("/millwright/api/foundry-login-actions",{credentials:"same-origin",cache:"no-store"});
        if(!response.ok)return;
        actions=await response.json();
      } catch { return; }
      const makeButton=(label,url)=>{
        const button=document.createElement("button");
        button.type="button";button.textContent=label;
        button.className="millwright-login-button";
        button.style.cssText="box-sizing:border-box;display:block;width:100%;min-height:38px;margin:0;padding:8px 12px;background:#465775;color:#fff;border:1px solid #8292ad;border-radius:4px;cursor:pointer;font:inherit;font-weight:600;text-align:center;white-space:normal";
        button.addEventListener("mouseenter",()=>button.style.backgroundColor="#586c91");
        button.addEventListener("mouseleave",()=>button.style.backgroundColor="#465775");
        button.addEventListener("focus",()=>button.style.outline="2px solid #a6b9da");
        button.addEventListener("blur",()=>button.style.outline="");
        button.addEventListener("click",()=>location.assign(url));
        return button;
      };
      const findButton=(words)=>Array.from(document.querySelectorAll("button"))
        .find(b=>!b.classList.contains("millwright-login-button")&&words.test((b.textContent||"").trim()));
      const insertAfter=(target,label,url)=>{
        if(!target)return;
        if(target.parentElement?.querySelector(".millwright-login-button"))return;
        const button=makeButton(label,url);
        button.style.marginTop="8px";
        button.style.flex="0 0 100%";
        button.style.width="100%";
        // The Foundry form uses flex layout. Both native and assisted
        // controls must span a full row instead of sharing a flex line.
        target.style.flex="0 0 100%";
        target.style.width="100%";
        target.insertAdjacentElement("afterend",button);
      };
      const render=()=>{
        const addAction=(target,label,url)=>{
          if(!target)return;
          const existing=document.querySelector('.millwright-login-button[data-url="'+url+'"]');
          if(existing){
            if(existing.previousElementSibling===target)return;
            existing.remove();
          }
          insertAfter(target,label,url);
          const inserted=target.nextElementSibling;
          if(inserted?.classList.contains("millwright-login-button"))inserted.dataset.url=url;
        };
        if(location.pathname==="/join"){
          if(actions.player)addAction(findButton(/join game session|join session|log in/i),
            "JOIN SESSION AS "+actions.displayName,"/millwright/api/autologin");
          if(actions.administrator)addAction(findButton(/return to setup|setup|administration/i),
            "USE MILLWRIGHT SESSION","/millwright/api/admin/foundry/open");
        }else if(actions.administrator){
          addAction(findButton(/log in|login/i),
            "USE MILLWRIGHT SESSION","/millwright/api/admin/foundry/open");
        }
      };
      let scheduled=false;
      const observer=new MutationObserver(records=>{
        if(!records.some(record=>Array.from(record.addedNodes).some(node=>
          node.nodeType===1&&!node.classList?.contains("millwright-login-button"))))return;
        if(scheduled)return;
        scheduled=true;
        setTimeout(()=>{scheduled=false;render();},0);
      });
      observer.observe(document.body,{childList:true,subtree:true});
      render();
    })();`;
  });

  app.get("/api/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { identity: request.discordIdentity };
  });
  app.get<{ Params: { worldId: string } }>("/api/worlds/:worldId/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const worldId = request.params.worldId;
    if (!worldId.trim()) return reply.code(400).send({ error: "Invalid world ID" });
    const identity = request.discordIdentity;
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    const mapping = getAccountMapping(options.database, worldId, identity.userId);
    if (!mapping) return reply.code(404).send({ error: "Account mapping not found" });
    return { mapping };
  });
  // The module reports observed client state. This is never an authorization assertion.
  app.post<{
    Params: { worldId: string };
    Body: { activeFoundryUserId: string | null; activeFoundryUserRole: number | null };
  }>("/api/worlds/:worldId/session/observe", {
    schema: {
      params: { type: "object", required: ["worldId"], properties: {
        worldId: { type: "string", minLength: 1, maxLength: 128 }
      } },
      body: { type: "object", additionalProperties: false,
        required: ["activeFoundryUserId", "activeFoundryUserRole"],
        properties: {
          activeFoundryUserId: { anyOf: [{ type: "string", minLength: 1, maxLength: 128 }, { type: "null" }] },
          activeFoundryUserRole: { anyOf: [{ type: "integer", minimum: 0, maximum: 4 }, { type: "null" }] }
        }
      }
    }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Browser-origin write protection: require same-origin Fetch Metadata.
    // Requests without a browser Sec-Fetch-Site signal are not accepted.
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Same-origin request required" });
    }
    const sessionId = request.millwrightSessionId;
    if (!sessionId || !request.discordIdentity) return reply.code(401).send({ error: "Unauthorized" });
    const result = observeFoundrySession(options.database, {
      worldId: request.params.worldId,
      millwrightSessionId: sessionId,
      activeFoundryUserId: request.body.activeFoundryUserId,
      activeFoundryUserRole: request.body.activeFoundryUserRole,
    });
    return { observation: {
      worldId: result.worldId,
      activeFoundryUserId: result.activeFoundryUserId,
      activeFoundryUserRole: result.activeFoundryUserRole,
      observedAt: result.observedAt,
    } };
  });
  app.get("/api/health", async () => ({ status: "ok" }));

  // Diagnostic only: forwarded headers are not independent proof of identity.
  if (options.identityDiagnostic) {
    app.get("/api/diagnostics/identity", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const subject = request.headers["x-millwright-subject"];
      return {
        subject: typeof subject === "string" ? subject : null,
        parsedIdentity: parseDiscordSubject(subject),
        receivedHeaderNames: Object.keys(request.headers)
          .filter(name => name.startsWith("x-") && !name.includes("token") && !name.includes("authorization"))
          .sort(),
        warning: "Diagnostic only; forwarded header is not independently authenticated",
      };
    });
  }
  return app;
}
