/** Read-only Discord guild member discovery. No bot credentials are returned. */
export type DiscordMember = {
  id: string;
  username: string;
  globalName: string | null;
  displayName: string;
  avatar: string | null;
};

export async function listGuildMembers(
  guildId: string,
  token: string,
  limit = 100,
  after?: string,
): Promise<{ members: DiscordMember[]; nextAfter: string | null }> {
  if (!/^[0-9]{17,20}$/.test(guildId) || !token.trim()) {
    throw new Error("Discord member discovery is not configured");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 ||
      (after !== undefined && !/^[0-9]{17,20}$/.test(after))) {
    throw new Error("Invalid Discord member pagination parameters");
  }

  const url = new URL(`https://discord.com/api/v10/guilds/${guildId}/members`);
  url.searchParams.set("limit", String(limit));
  if (after) url.searchParams.set("after", after);
  const response = await fetch(url, {
    headers: { Authorization: `Bot ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Discord member discovery failed (HTTP ${response.status})`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("Unexpected Discord members response");

  const members: DiscordMember[] = [];
  let lastId: string | null = null;
  for (const item of data) {
    if (!item || typeof item !== "object") throw new Error("Invalid Discord member");
    const member = item as Record<string, unknown>;
    if (!member.user || typeof member.user !== "object") throw new Error("Invalid Discord member user");
    const user = member.user as Record<string, unknown>;
    if (typeof user.id !== "string" || !/^[0-9]{17,20}$/.test(user.id) ||
        typeof user.username !== "string") throw new Error("Invalid Discord member identity");
    lastId = user.id;
    if (user.bot === true) continue;
    const globalName = typeof user.global_name === "string" ? user.global_name : null;
    const nick = typeof member.nick === "string" ? member.nick : null;
    members.push({
      id: user.id,
      username: user.username,
      globalName,
      displayName: nick || globalName || user.username,
      avatar: typeof member.avatar === "string" ? member.avatar :
        typeof user.avatar === "string" ? user.avatar : null,
    });
  }
  // A full page may have more results. Use the last raw member ID, including bots,
  // so pagination never loops or skips members.
  return { members, nextAfter: data.length === limit ? lastId : null };
}
