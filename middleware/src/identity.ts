import { z } from "zod";

const discordSubject = z.string().regex(/^discord\.com\/([0-9]{17,20})$/);

export type DiscordIdentity = {
  provider: "discord";
  userId: string;
  subject: string;
};

export function parseDiscordSubject(value: unknown): DiscordIdentity | null {
  if (typeof value !== "string") return null;
  const result = discordSubject.safeParse(value);
  if (!result.success) return null;
  return { provider: "discord", userId: result.data.slice("discord.com/".length), subject: result.data };
}
