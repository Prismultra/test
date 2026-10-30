import { COMMANDS } from "./commands/definitions.js";

export interface RegisterResult {
  ok: boolean;
  status: number;
  names: string[];
  error?: string;
}

/** Overwrites the bot's slash commands, globally or for one guild (guild updates are instant). */
export async function registerCommands(appId: string, botToken: string, guildId?: string, fetchImpl: typeof fetch = fetch): Promise<RegisterResult> {
  const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
  const res = await fetchImpl(`https://discord.com/api/v10${path}`, {
    method: "PUT",
    headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  if (!res.ok) return { ok: false, status: res.status, names: [], error: (await res.text()).slice(0, 1000) };
  const registered = (await res.json()) as { name: string }[];
  return { ok: true, status: res.status, names: registered.map((c) => c.name) };
}

export const inviteUrl = (appId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${appId}&scope=applications.commands+bot&permissions=0`;
