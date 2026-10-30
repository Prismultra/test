import { ButtonStyle } from "discord-api-types/v10";
import { addCondition, removeCondition } from "../game/character.js";
import {
  ARMOR,
  CONDITIONS,
  MAGIC_ITEMS,
  MONSTERS,
  SPELLS,
  WEAPONS,
  crText,
  findCondition,
  findMonster,
  normalize,
  searchByName,
} from "../srd/index.js";
import { UserError, button, row, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { editCharacter, requireActive } from "./characters.js";
import { syncCharacterToCombat } from "./combat-store.js";
import { choice, type CommandModule, type ComponentModule } from "./registry.js";
import {
  armorEmbed,
  conditionEmbed,
  magicItemEmbed,
  monsterEmbed,
  spellEmbed,
  weaponEmbed,
  type MonsterPage,
} from "./views.js";
import type { SrdMonster } from "../srd/types.js";

function monsterReply(m: SrdMonster, page: MonsterPage, ephemeral: boolean): Reply {
  return {
    embeds: [monsterEmbed(m, page)],
    components: [
      row(
        button(`mon:${m.id}:stats`, "Stats & traits", page === "stats" ? ButtonStyle.Primary : ButtonStyle.Secondary, "📜"),
        button(`mon:${m.id}:actions`, "Actions", page === "actions" ? ButtonStyle.Primary : ButtonStyle.Secondary, "⚔️"),
      ),
    ],
    ephemeral,
  };
}

export const monsterCommand: CommandModule = {
  names: ["monster"],
  async run(ctx) {
    const name = ctx.requireString("name");
    const m = findMonster(name);
    if (!m) throw new UserError(`No SRD monster matches "${name}".`);
    return monsterReply(m, "stats", ctx.boolean("private") ?? false);
  },
  async autocomplete(ctx) {
    return searchByName(MONSTERS, ctx.focused?.value ?? "", 25).map((m) => choice(`${m.name} (CR ${crText(m.cr)})`, m.id));
  },
};

export const monsterPages: ComponentModule = {
  prefix: "mon",
  async run(_ctx, [id, page]) {
    const m = MONSTERS.find((x) => x.id === id);
    if (!m) throw new UserError("That monster is gone.");
    return { ...monsterReply(m, page === "actions" ? "actions" : "stats", false), update: true };
  },
};

export const conditionCommand: CommandModule = {
  names: ["condition"],
  async run(ctx) {
    const name = ctx.requireString("name");
    const action = ctx.string("action") ?? "info";
    const srd = findCondition(name);
    if (action === "info") {
      if (!srd) throw new UserError(`No SRD condition matches "${name}".`);
      return { embeds: [conditionEmbed(srd)] };
    }
    const label = srd && normalize(srd.name) === normalize(name) ? srd.name : name.trim().slice(0, 40);
    const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    const { char, result } = await editCharacter(
      ctx.store,
      active,
      (c) => (action === "add" ? (addCondition(c, label), true) : removeCondition(c, label)),
      ctx.now(),
    );
    await syncCharacterToCombat(ctx.store, ctx.channelId, char).catch(() => undefined);
    if (action === "remove" && !result) throw new UserError(`${char.name} isn't ${label}.`);
    const verb = action === "add" ? "is now" : "is no longer";
    const reply: Reply = { content: `**${char.name}** ${verb} **${label}**.` };
    if (action === "add" && srd) reply.embeds = [conditionEmbed(srd)];
    return reply;
  },
  async autocomplete(ctx) {
    return searchByName(CONDITIONS, ctx.focused?.value ?? "", 25).map((c) => choice(c.name, c.name));
  },
};

type ItemHit = { kind: "magic" | "weapon" | "armor"; id: string; name: string; label: string };

function searchItems(q: string, limit = 25): ItemHit[] {
  const hits: ItemHit[] = [
    ...searchByName(WEAPONS, q, limit).map((w) => ({ kind: "weapon" as const, id: w.id, name: w.name, label: `${w.name} (weapon)` })),
    ...searchByName(ARMOR, q, limit).map((a) => ({ kind: "armor" as const, id: a.id, name: a.name, label: `${a.name} (armor)` })),
    ...searchByName(MAGIC_ITEMS, q, limit).map((i) => ({
      kind: "magic" as const,
      id: i.id,
      name: i.name,
      label: `${i.name} (${i.rarity.toLowerCase()})`,
    })),
  ];
  // Re-rank the combined list by name match quality.
  return searchByName(hits.map((h) => ({ ...h, id: `${h.kind}:${h.id}` })), q, limit).map((h) => ({
    ...h,
    id: h.id.slice(h.id.indexOf(":") + 1),
  }));
}

export const itemCommand: CommandModule = {
  names: ["item"],
  async run(ctx) {
    const q = ctx.requireString("name");
    const [kind, id] = q.includes(":") ? (q.split(":", 2) as [string, string]) : ["", ""];
    const hit = kind && id ? { kind, id } : searchItems(q, 1)[0];
    if (!hit) throw new UserError(`No SRD item matches "${q}".`);
    const ephemeral = ctx.boolean("private") ?? false;
    if (hit.kind === "weapon") {
      const w = WEAPONS.find((x) => x.id === hit.id);
      if (w) return { embeds: [weaponEmbed(w)], ephemeral };
    } else if (hit.kind === "armor") {
      const a = ARMOR.find((x) => x.id === hit.id);
      if (a) return { embeds: [armorEmbed(a)], ephemeral };
    } else {
      const i = MAGIC_ITEMS.find((x) => x.id === hit.id);
      if (i) return { embeds: [magicItemEmbed(i)], ephemeral };
    }
    throw new UserError(`No SRD item matches "${q}".`);
  },
  async autocomplete(ctx) {
    return searchItems(ctx.focused?.value ?? "", 25).map((h) => choice(h.label, `${h.kind}:${h.id}`));
  },
};

export const spellLookupChoices = (q: string) =>
  searchByName(SPELLS, q, 25).map((s) => choice(`${s.name} (${s.level === 0 ? "cantrip" : `level ${s.level}`})`, s.name));

export { spellEmbed };
