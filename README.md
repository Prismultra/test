# 🍺 Tavernkeep

A Discord bot for fifth-edition tabletop games: dice, character sheets, a combat tracker, SRD 5.1 rules lookups, and an optional **AI Dungeon Master** powered by Claude.

It runs as a single serverless function (Discord's slash-command webhooks, no always-on server), so it's free to host on Vercel's Hobby plan with a free Supabase database.

## What it does

| | Commands |
|---|---|
| 🎲 **Dice** | `/roll 2d6+3` · `/roll 1d20+5 adv` · `/roll 4d6dl1 repeat:6` · `/roll 8d6 fire` — keep/drop (`kh` `kl` `dh` `dl`), exploding `!`, reroll-low `ro1`, damage-type labels, crit highlights |
| 🧙 **Characters** | `/char create` (SRD classes get saves, HP and spell slots automatically) · `/char sheet` · `/char set` · `/char prof` · `/char attack-add` (SRD weapons fill in to-hit and damage) · several characters per player |
| 🎯 **Rolling as your character** | `/check stealth` · `/save dex` · `/attack longsword target:Goblin A` (hits, crits and applies damage) · `/deathsave` |
| ❤️ **Resources** | `/hp damage/heal/temp/set` (temp HP, massive damage, death saves) · `/rest short/long` (hit dice, slots) · `/spell cast` (slots incl. warlock pact magic) · `/inv add/remove/coins` |
| ⚔️ **Combat tracker** | `/init start` · `/init join` · `/init monster goblin count:4` (rolls HP + initiative) · ▶️ Next-turn buttons · `/init damage/heal/condition` · monster HP hidden from players by default · player HP stays in sync with sheets |
| 📚 **SRD 5.1 lookups** | `/monster` (334 stat blocks) · `/spell info` (319 spells) · `/condition` · `/item` — all with autocomplete |
| 🐉 **AI Dungeon Master** | `/dm start` · `/dm join` · `/act` · `/dm ask` · `/dm recap` · `/dm status` · `/dm end` |

### The AI Dungeon Master

Start a campaign in a channel with `/dm start` (optionally give a premise, tone and length), then everyone plays with `/act`.

- It narrates, voices NPCs, and runs monsters with **visible dice rolls**.
- When your character attempts something risky, it asks for a check: a **🎲 button** appears, you click it, and your sheet's modifiers are applied. The story continues once everyone's rolled.
- It reads and updates your sheets: damage, healing, conditions, loot, coins and XP.
- It starts fights with the real combat tracker, using SRD monster stats.
- Actions sent while it's still writing are queued and handled together.
- It keeps a running summary and notes so long campaigns stay consistent.

The AI DM uses `claude-opus-5-5` by default (change with `DM_MODEL`). It's billed per use to your Anthropic API account — `/dm status` shows the tokens a campaign has used. Everything else works without it.

## Setup (about 15 minutes, all in the browser)

You need accounts on [Discord](https://discord.com/developers/applications), [GitHub](https://github.com), [Vercel](https://vercel.com) and [Supabase](https://supabase.com) (all free), plus an [Anthropic API key](https://platform.claude.com) if you want the AI DM.

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, name it (e.g. *Tavernkeep*).
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**, click **Reset Token** and copy the token. Keep it secret.

### 2. Create the database

1. In [Supabase](https://supabase.com/dashboard), create a new project.
2. Open **SQL Editor**, paste the contents of [`supabase/migrations/0001_kv.sql`](supabase/migrations/0001_kv.sql), and run it.
3. In **Project Settings → API**, copy the **Project URL** and the **service_role** key (not the anon key).

### 3. Deploy to Vercel

1. In [Vercel](https://vercel.com/new), import this GitHub repository. No build settings are needed.
2. Add these **Environment Variables**:

   | Name | Value |
   |---|---|
   | `DISCORD_APPLICATION_ID` | from step 1 |
   | `DISCORD_PUBLIC_KEY` | from step 1 |
   | `DISCORD_BOT_TOKEN` | from step 1 |
   | `REGISTER_KEY` | any long random password you make up |
   | `SUPABASE_URL` | from step 2 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 2 |
   | `ANTHROPIC_API_KEY` | optional — turns on the AI DM |

3. Deploy, and note your URL, e.g. `https://tavernkeep-yourname.vercel.app`.

### 4. Connect Discord to it

1. Back in the Developer Portal → **General Information**, set **Interactions Endpoint URL** to
   `https://<your-app>.vercel.app/api/interactions` and save. (Discord checks it right away; if it fails, double-check `DISCORD_PUBLIC_KEY`.)
2. Register the slash commands by opening this in your browser:
   `https://<your-app>.vercel.app/api/register?key=<your REGISTER_KEY>`
   - Add `&guild=<your server ID>` to make them appear in that server instantly (global commands can take up to an hour). To copy a server ID, turn on Developer Mode in Discord settings → right-click the server → **Copy Server ID**.
3. Click the **invite link** on that page and add the bot to your server.

Type `/help` in Discord. 🎉

## Development

```bash
npm install
cp .env.example .env   # fill it in (Supabase is optional locally; memory is used without it)
npm test               # 56 tests: dice, rules, commands end to end, AI DM with a scripted model
npm run typecheck
npm run dev            # local server on :3000 — expose it with a tunnel, e.g.
                       # cloudflared tunnel --url http://localhost:3000
npm run register       # register commands from your machine instead of /api/register
npm run build:srd      # regenerate src/srd/data from the 5e-bits SRD database
```

Layout:

- `api/` — Vercel functions (`interactions` is the bot, `register` is the setup page)
- `src/app.ts` — signature check, routing, and automatic deferral for anything slower than ~2 seconds
- `src/commands/` — one module per slash command
- `src/game/` — dice engine, 5e rules tables, character and combat logic (no Discord code)
- `src/ai/` — the Dungeon Master: prompt, tools, turn loop, campaign state and locking
- `src/store/` — a tiny versioned key-value store (Supabase or in-memory) with compare-and-set updates

## Credits

Includes material from the System Reference Document 5.1 by Wizards of the Coast LLC, licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/legalcode); data structured by [5e-bits/5e-database](https://github.com/5e-bits/5e-database) (MIT). See [NOTICE.md](NOTICE.md). Tavernkeep is not affiliated with or endorsed by Wizards of the Coast.
