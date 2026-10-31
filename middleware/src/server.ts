import { readFileSync } from "node:fs";
import { z } from "zod";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const config = z.object({
  DISCORD_GUILD_ID: z.string().regex(/^[0-9]{17,20}$/).optional(),
  MILLWRIGHT_LISTEN_HOST: z.string().default("127.0.0.1"),
  MILLWRIGHT_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
}).parse(process.env);

const proxySecret = readFileSync("/run/secrets/middleware-proxy-key", "utf8").trim();
const bootstrapChallenge = readFileSync("/run/secrets/administrator-bootstrap-challenge", "utf8").trim();
const serviceCredentialKeyHex = readFileSync("/run/secrets/service-credential-key", "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(serviceCredentialKeyHex)) throw new Error("Invalid service credential encryption key");
// Load the service credential encryption key from the dedicated Docker secret.
const database = openDatabase();
const app = createApp({
  database,
  proxySecret,
  serviceCredentialKey: Buffer.from(serviceCredentialKeyHex, "hex"),
  discordGuildId: config.DISCORD_GUILD_ID,
  discordBotToken: readFileSync("/run/secrets/discord-bot-token", "utf8").trim(),
  bootstrapChallenge,
  identityDiagnostic: process.env.MILLWRIGHT_IDENTITY_DIAGNOSTIC === "true",
  logger: true,
});
app.addHook("onClose", async () => { database.close(); });

try {
  await app.listen({ host: config.MILLWRIGHT_LISTEN_HOST, port: config.MILLWRIGHT_LISTEN_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
