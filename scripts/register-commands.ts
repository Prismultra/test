// Registers the slash commands with Discord. Run with `npm run register`.
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN  required
//   DISCORD_GUILD_ID                            optional: register to one server instantly
//                                               (global commands can take a while to show up)
import { COMMANDS } from "../src/commands/definitions.js";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN (see .env.example).");
  process.exit(1);
}

const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
const res = await fetch(`https://discord.com/api/v10${path}`, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`Registration failed: ${res.status}\n${await res.text()}`);
  process.exit(1);
}

const registered = (await res.json()) as { name: string }[];
console.log(`Registered ${registered.length} commands ${guildId ? `to guild ${guildId}` : "globally"}: ${registered.map((c) => `/${c.name}`).join(" ")}`);
console.log(`\nInvite the bot: https://discord.com/oauth2/authorize?client_id=${appId}&scope=applications.commands+bot&permissions=0`);
