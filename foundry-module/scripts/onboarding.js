const M="millwright";
const steps=[
["#sidebar-tabs [data-tab='settings'], #sidebar-tabs .item[data-tab='settings']","Open Game Settings","Click the Settings icon to locate Millwright's tools."],
["#millwright-discord-account-linking-button","Discord Account Linking","Click this new button to manage Discord and Foundry account associations."],
["#millwright-tour-existing","Existing Foundry Accounts","Link existing Foundry users to Discord members. Linking does not change their Foundry roles."],
["#millwright-tour-create","Create and Link Players","Create a new Foundry account and link it to a Discord member in one operation. No accounts will be created by this tutorial."],
["#millwright-tour-role","Assign Foundry Roles","Player is the default. Trusted Player, Assistant GM, and Gamemaster have increasing permissions. Foundry roles control in-world permissions; Discord authentication and world-specific account mappings control access through Millwright; Discord server roles do not grant access. Existing roles can be changed in the account table."],
["#millwright-tour-create","You're Ready","Link existing users or create new ones. This tutorial does not modify any accounts or permissions."]
];
let index=-1,tip=null,highlight=null,oldOutline="",oldOffset="",generation=0;
const completed=new Set();
function clear(){
 tip?.remove();tip=null;
 if(highlight){highlight.style.outline=oldOutline;highlight.style.outlineOffset=oldOffset;}
 highlight=null;
}
async function end(done){++generation;clear();index=-1;completed.clear();if(done)await game.settings.set(M,"discordLinkIntroductionSeen",true);}
function locate(n){return document.querySelector(steps[n][0]);}
function visible(n){const el=locate(n),box=el?.getBoundingClientRect();return !!(el&&box.width&&box.height);}
function complete(n){
 completed.add(n);
 if(index!==n)return;
 const next=tip?.querySelector("[data-millwright-tour-next]");
 if(next)next.disabled=false;
 const hint=tip?.querySelector("[data-millwright-tour-hint]");
 if(hint)hint.textContent="Action recognized. Select Next when ready.";
}
function explainUnavailable(){
 const message=index===0?"Open the Game Settings sidebar to continue.":index===1?"Open Discord Account Linking to continue.":"Keep the Discord Account Linking window open to continue.";
 const hint=tip?.querySelector("[data-millwright-tour-hint]");
 if(hint)hint.textContent=message;
}
async function show(n){
 const token=++generation;clear();index=n;
 if(n===1){ui.sidebar?.expand?.();ui.sidebar?.activateTab?.("settings");}
 // A previously opened dialog also satisfies step 2.
 if(n===1&&visible(2))completed.add(1);
 const el=locate(n);
 if(!el){
  if(n>0){void show(n-1);}else{ui.notifications?.warn("Open Game Settings to start the tutorial.");void end(false);}
  return;
 }
 const box=el.getBoundingClientRect();
 if(!box.width||!box.height){
  if(n>0){void show(n-1);}else{ui.notifications?.warn("Open Game Settings to start the tutorial.");void end(false);}
  return;
 }
 if(token!==generation)return;
 highlight=el;oldOutline=el.style.outline;oldOffset=el.style.outlineOffset;
 el.style.outline="3px solid #e5b64d";el.style.outlineOffset="3px";
 el.scrollIntoView({block:"nearest"});
 const panel=document.createElement("section");
 panel.setAttribute("role","dialog");panel.setAttribute("aria-label","Millwright guided tutorial");
 panel.style.cssText="position:fixed;z-index:100000;padding:1rem;background:#17121f;color:#f3ebd6;border:2px solid #e5b64d;border-radius:8px;box-shadow:0 8px 24px #000a;width:min(370px,calc(100vw - 24px))";
 const title=document.createElement("h3");title.textContent=(n+1)+"/"+steps.length+" — "+steps[n][1];
 const desc=document.createElement("p");desc.textContent=steps[n][2];
 const hint=document.createElement("p");hint.dataset.millwrightTourHint="";hint.setAttribute("role","status");
 const controls=document.createElement("div");controls.style.cssText="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap";
 const add=(label,fn)=>{const btn=document.createElement("button");btn.type="button";btn.textContent=label;btn.addEventListener("click",fn);controls.append(btn);return btn;};
 add("Skip Tutorial",()=>void end(true));
 if(n>0)add("Back",()=>void show(n-1));
 const next=add(n===steps.length-1?"Finish":"Next",()=>{
  if(n===steps.length-1){void end(true);return;}
  if(n<2&&!completed.has(n)){explainUnavailable();return;}
  if(!visible(n+1)){explainUnavailable();return;}
  void show(n+1);
 });
 next.dataset.millwrightTourNext="";
 next.disabled=n<2&&!completed.has(n);
 if(n<2)hint.textContent=completed.has(n)?"Action recognized. Select Next when ready.":"Perform the highlighted action to enable Next.";
 panel.append(title,desc,hint,controls);document.body.append(panel);tip=panel;
 const rect=el.getBoundingClientRect(),height=panel.getBoundingClientRect().height,width=panel.getBoundingClientRect().width;
 panel.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+"px";
 panel.style.top=(rect.bottom+height+12<innerHeight?rect.bottom+12:Math.max(12,rect.top-height-12))+"px";
}
export function registerDiscordLinkIntroduction(){
 game.settings.register(M,"discordLinkIntroductionSeen",{scope:"client",config:false,type:Boolean,default:false});
 game.settings.registerMenu(M,"replayDiscordLinkIntroduction",{
  name:"Discord Account Linking Tutorial",label:"Replay Tutorial",hint:"Walk through account linking and Foundry role assignment.",
  icon:"fas fa-circle-info",restricted:true,
  type:class extends foundry.applications.api.ApplicationV2{
   static DEFAULT_OPTIONS={id:"millwright-replay-discord-introduction",window:{title:"Millwright — Tutorial"}};
   async _renderHTML(){const root=document.createElement("section"),button=document.createElement("button");root.style.padding="1rem";button.textContent="Start Guided Tutorial";button.addEventListener("click",()=>{void this.close();startDiscordLinkIntroduction(true);});root.append(button);return root;}
   _replaceHTML(result,content){content.replaceChildren(result);}
  }
 });
 document.addEventListener("click",event=>{
  if(index!==0||!locate(0)?.contains(event.target))return;
  complete(0);
  // Opening Settings completes the action step; do not require Next.
  void show(1);
},true);
 Hooks.on("millwrightDiscordLinkWindowReady",()=>{
  if(index!==1)return;
  complete(1);
  // Step 2 is an action step: opening the dialog completes it. Informational
  // steps 3–6 remain user-paced via Next.
  if(visible(2))void show(2);
});
}
export function startDiscordLinkIntroduction(force=false){
 if(!game.user?.isGM||!game.world?.id)return;
 if(!force&&game.settings.get(M,"discordLinkIntroductionSeen"))return;
 completed.clear();
 void show(0);
}
