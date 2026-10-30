// One-time setup from a browser: visit /api/register?key=<REGISTER_KEY> to
// register the slash commands (add &guild=<server id> for instant updates in one server).
import { timingSafeEqual } from "node:crypto";
import { inviteUrl, registerCommands } from "../src/register.js";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5"><h1>${escape(title)}</h1>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function keyMatches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const expected = process.env.REGISTER_KEY?.trim();
    const appId = process.env.DISCORD_APPLICATION_ID?.trim();
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!expected) return page("Not set up", "<p>Set a <code>REGISTER_KEY</code> environment variable in Vercel, redeploy, then visit this page with <code>?key=</code> that value.</p>", 403);
    if (!keyMatches(url.searchParams.get("key") ?? "", expected)) return page("Wrong key", "<p>The <code>key</code> doesn't match <code>REGISTER_KEY</code>.</p>", 403);
    if (!appId || !token) return page("Missing settings", "<p>Set <code>DISCORD_APPLICATION_ID</code> and <code>DISCORD_BOT_TOKEN</code> in Vercel and redeploy.</p>", 400);

    const guild = url.searchParams.get("guild")?.trim() || undefined;
    if (guild && !/^\d{5,25}$/.test(guild)) return page("Bad server id", "<p><code>guild</code> must be a numeric server ID.</p>", 400);
    const result = await registerCommands(appId, token, guild);
    if (!result.ok) {
      return page("Registration failed", `<p>Discord said ${result.status}:</p><pre style="white-space:pre-wrap">${escape(result.error ?? "")}</pre>`, 502);
    }
    const invite = inviteUrl(appId);
    return page(
      "Commands registered ✅",
      `<p>Registered ${result.names.length} commands ${guild ? "to your server (available now)" : "globally (can take up to an hour to appear)"}:</p>` +
        `<p>${result.names.map((n) => `<code>/${escape(n)}</code>`).join(" ")}</p>` +
        `<p><a href="${escape(invite)}">Invite the bot to a server</a></p>`,
    );
  },
};
