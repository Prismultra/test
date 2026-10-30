// Registers the slash commands with Discord. Run with `npm run register`.
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN  required
//   DISCORD_GUILD_ID                            optional: register to one server instantly
//                                               (global commands can take a while to show up)
// You can also do this from a browser once deployed: see /api/register in the README.
import { inviteUrl, registerCommands } from "../src/register.js";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID || undefined;

if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN (see .env.example).");
  process.exit(1);
}

const result = await registerCommands(appId, token, guildId);
if (!result.ok) {
  console.error(`Registration failed: ${result.status}\n${result.error}`);
  process.exit(1);
}
console.log(`Registered ${result.names.length} commands ${guildId ? `to guild ${guildId}` : "globally"}: ${result.names.map((n) => `/${n}`).join(" ")}`);
console.log(`\nInvite the bot: ${inviteUrl(appId)}`);
