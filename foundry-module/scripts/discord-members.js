/** Shared Discord member inventory and display conventions for Millwright UI. */
export async function listDiscordMembers() {
  const members = [];
  let after = null;
  const seen = new Set();
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("after", after);
    const response = await fetch("/millwright/api/discord/members?" + query, {
      credentials: "same-origin", cache: "no-store",
    });
    const page = await response.json().catch(() => null);
    if (!response.ok) throw new Error(page?.error || `Discord member lookup failed (HTTP ${response.status})`);
    if (!Array.isArray(page?.members)) throw new Error("Invalid Discord member inventory");
    members.push(...page.members);
    after = page.nextAfter;
    if (after && seen.has(after)) throw new Error("Discord member pagination repeated");
    if (after) seen.add(after);
  } while (after);
  return members;
}

export function discordMemberDisplayName(member) {
  return member.displayName || member.globalName || member.username;
}

export function discordMemberLabel(member) {
  return `${discordMemberDisplayName(member)} (@${member.username})`;
}
