// /party: the Dungeon Master's controls over the party's sheets.
import {
  addCondition,
  addItem,
  adjustCoins,
  applyDamage,
  coinsText,
  heal,
  hpBar,
  longRest,
  removeCondition,
  removeItem,
  setTempHp,
  type Character,
  type Coins,
} from "../game/character.js";
import { levelForXp } from "../game/rules.js";
import { ARMOR, CONDITIONS, MAGIC_ITEMS, WEAPONS, searchByName } from "../srd/index.js";
import { COLORS, UserError, embed, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { editCharacter } from "../commands/characters.js";
import { FIELDS } from "../commands/char.js";
import { syncCharacterToCombat } from "../commands/combat-store.js";
import { isDmOrManager } from "../commands/dm-guard.js";
import { choice, type CommandModule } from "../commands/registry.js";
import { requireCampaign, type Campaign, type PartyMember } from "./campaign.js";

async function requireDm(ctx: Ctx): Promise<Campaign> {
  const c = await requireCampaign(ctx.store, ctx.channelId);
  if (!isDmOrManager(ctx, c)) throw new UserError("Only the Dungeon Master can use `/party`.");
  return c;
}

function member(c: Campaign, userId: string): PartyMember {
  const m = c.party.find((p) => p.userId === userId);
  if (!m) throw new UserError("That player isn't in the party. They can join with `/dm join`.");
  return m;
}

/** Edits one party member's sheet and keeps the combat tracker in sync. */
async function edit<R>(ctx: Ctx, c: Campaign, m: PartyMember, fn: (ch: Character) => R) {
  const out = await editCharacter(ctx.store, { guildId: c.guildId, ownerId: m.userId, id: m.characterId }, fn, ctx.now());
  await syncCharacterToCombat(ctx.store, ctx.channelId, out.char).catch(() => undefined);
  return out;
}

const hpLine = (ch: Character) => `${ch.hp}/${ch.maxHp}${ch.tempHp ? ` (+${ch.tempHp} temp)` : ""} ${hpBar(ch.hp, ch.maxHp, 8)}`;

export const partyCommand: CommandModule = {
  names: ["party"],
  async run(ctx): Promise<Reply> {
    const c = await requireDm(ctx);
    const sub = ctx.subcommand;

    if (sub === "rest" || sub === "xp") {
      const lines: string[] = [];
      const amount = sub === "xp" ? ctx.requireInteger("amount") : 0;
      for (const m of c.party) {
        const { char } = await edit(ctx, c, m, (ch) => {
          if (sub === "rest") longRest(ch);
          else ch.xp = Math.max(0, ch.xp + amount);
        });
        if (sub === "rest") lines.push(`**${char.name}** ${hpLine(char)}`);
        else {
          const next = levelForXp(char.xp);
          lines.push(`**${char.name}**: ${char.xp} XP${next > char.level ? ` — ready for level ${next}! (\`/party set field:level\`)` : ""}`);
        }
      }
      const title = sub === "rest" ? "🌙 The party takes a long rest" : `✨ The party earns ${amount} XP each`;
      return { embeds: [embed({ title, description: lines.join("\n") || "_The party is empty._", color: COLORS.success })] };
    }

    const m = member(c, ctx.requireString("player"));
    switch (sub) {
      case "hp": {
        const action = ctx.requireString("action");
        const amount = ctx.requireInteger("amount");
        const { char, result } = await edit(ctx, c, m, (ch) => {
          if (action === "damage") return applyDamage(ch, amount);
          if (action === "heal") return void heal(ch, amount);
          if (action === "temp") return void setTempHp(ch, amount);
          ch.hp = Math.min(ch.maxHp, Math.max(0, amount));
          if (ch.hp > 0) ch.deathSaves = { successes: 0, failures: 0 };
          return undefined;
        });
        const verb = { damage: `takes **${amount}** damage`, heal: `heals **${amount}**`, temp: `gains **${amount}** temp HP`, set: "HP set" }[action] ?? action;
        const extra = result?.instantDeath ? "\n☠️ **Massive damage** — instant death!" : result?.droppedToZero ? "\n💀 **Down!** Roll death saves with `/deathsave`." : "";
        return { content: `🧙 **${char.name}** ${verb}.${extra}\n${hpLine(char)}` };
      }
      case "set": {
        const field = ctx.requireString("field").toLowerCase().replace(/\s+/g, "");
        const def = Object.hasOwn(FIELDS, field) ? FIELDS[field] : undefined;
        if (!def) throw new UserError(`Unknown field "${field}". Pick one from the list.`);
        const { char, result } = await edit(ctx, c, m, (ch) => def.apply(ch, ctx.requireString("value")));
        return { content: `🧙 **${char.name}**: ${result}` };
      }
      case "give": {
        const item = ctx.requireString("item");
        const qty = ctx.integer("qty") ?? 1;
        if (qty === 0) throw new UserError("Give a quantity other than 0 (negative takes items away).");
        const { char, result } = await edit(ctx, c, m, (ch) => (qty > 0 ? (addItem(ch, item, qty), true) : removeItem(ch, item, -qty)));
        if (!result) throw new UserError(`${char.name} isn't carrying "${item}".`);
        return { content: qty > 0 ? `🎁 **${char.name}** receives ${qty > 1 ? `${qty}× ` : ""}**${item}**.` : `🫳 **${char.name}** loses ${-qty}× **${item}**.` };
      }
      case "coins": {
        const delta: Partial<Coins> = {};
        for (const k of ["pp", "gp", "sp", "cp"] as const) {
          const v = ctx.integer(k);
          if (v) delta[k] = v;
        }
        if (!Object.keys(delta).length) throw new UserError("Give an amount, e.g. `gp: 25` or `gp: -10`.");
        const { char, result } = await edit(ctx, c, m, (ch) => adjustCoins(ch, delta));
        if (!result) throw new UserError(`${char.name} can't afford that (has ${coinsText(char.coins)}).`);
        return { content: `💰 **${char.name}** now has ${coinsText(char.coins)}.` };
      }
      case "condition": {
        const cond = ctx.requireString("condition");
        const remove = ctx.boolean("remove") ?? false;
        const { char } = await edit(ctx, c, m, (ch) => (remove ? removeCondition(ch, cond) : addCondition(ch, cond)));
        return { content: `🧙 **${char.name}** ${remove ? "is no longer" : "is now"} **${cond}**.` };
      }
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
  async autocomplete(ctx) {
    const f = ctx.focused;
    if (!f) return [];
    const q = f.value.toLowerCase();
    if (f.name === "field") {
      return Object.entries(FIELDS)
        .filter(([k, d]) => k.includes(q) || d.label.toLowerCase().includes(q))
        .slice(0, 25)
        .map(([k, d]) => choice(d.label, k));
    }
    if (f.name === "condition") return searchByName(CONDITIONS, f.value, 25).map((x) => choice(x.name));
    if (f.name === "item") {
      const hits = f.value ? searchByName([...MAGIC_ITEMS, ...WEAPONS, ...ARMOR], f.value, 24).map((x) => choice(x.name)) : [];
      if (f.value && !hits.some((h) => h.value.toLowerCase() === q)) hits.unshift(choice(f.value));
      return hits.slice(0, 25);
    }
    return [];
  },
};
