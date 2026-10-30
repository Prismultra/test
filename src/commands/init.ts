import { ButtonStyle } from "discord-api-types/v10";
import { applyDamage, heal, initiativeMod } from "../game/character.js";
import {
  addCombatant,
  addMonsters,
  createCombat,
  current,
  damageCombatant,
  findCombatant,
  healCombatant,
  isDown,
  nextTurn,
  prevTurn,
  pushLog,
  removeCombatant,
  renderOrder,
  type Combat,
  type Combatant,
} from "../game/combat.js";
import { applyMode, evaluate, parse } from "../game/dice.js";
import { CONDITIONS, MONSTERS, crText, findMonster, searchByName } from "../srd/index.js";
import { keys } from "../store/store.js";
import { COLORS, UserError, button, embed, row, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { editCharacter, requireActive } from "./characters.js";
import { editCombat, getCombat } from "./combat-store.js";
import { choice, type CommandModule, type ComponentModule } from "./registry.js";
import { parseMode } from "./roll.js";

export function trackerReply(combat: Combat, opts: { revealHp?: boolean; ephemeral?: boolean; note?: string } = {}): Reply {
  const who = current(combat);
  const fields = [];
  if (who) {
    const owner = who.ownerId ? ` (<@${who.ownerId}>)` : "";
    fields.push({ name: "Up now", value: `**${who.name}**${owner}${isDown(who) ? " — at 0 HP, roll `/deathsave`" : ""}` });
  }
  if (combat.log.length) fields.push({ name: "Recent", value: combat.log.slice(-4).join("\n") });
  const e = embed({
    title: `⚔️ Combat — Round ${combat.round}`,
    description: [opts.note, renderOrder(combat, opts.revealHp ? { revealHp: true } : {})].filter(Boolean).join("\n\n"),
    fields,
    color: COLORS.danger,
    footer: "Buttons work for everyone · /init damage, /init heal, /init condition",
  });
  const reply: Reply = {
    embeds: [e],
    components: [
      row(
        button("init:prev", "Prev", ButtonStyle.Secondary, "◀️"),
        button("init:next", "Next turn", ButtonStyle.Primary, "▶️"),
        button("init:refresh", "Refresh", ButtonStyle.Secondary, "🔄"),
        button("init:end", "End combat", ButtonStyle.Danger, "⏹️"),
      ),
    ],
  };
  if (opts.ephemeral) {
    reply.ephemeral = true;
    delete reply.components;
  }
  return reply;
}

async function start(ctx: Ctx): Promise<Reply> {
  const existing = await getCombat(ctx.store, ctx.channelId);
  if (existing) {
    return { ...trackerReply(existing, { note: "A combat is already running here. `/init end` to finish it." }) };
  }
  const combat = createCombat({
    channelId: ctx.channelId,
    guildId: ctx.guildId,
    createdBy: ctx.userId,
    hideMonsterHp: !(ctx.boolean("show_monster_hp") ?? false),
    now: ctx.now().toISOString(),
  });
  await ctx.store.put(keys.combat(ctx.channelId), combat, "create");
  return trackerReply(combat, { note: "🗡️ **Roll for initiative!** Players: `/init join`. DM: `/init monster` or `/init add`." });
}

async function join(ctx: Ctx): Promise<Reply> {
  const c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
  const manual = ctx.integer("initiative");
  const bonus = initiativeMod(c);
  const rolled =
    manual === undefined ? evaluate(applyMode(parse(`1d20${bonus >= 0 ? "+" : ""}${bonus}`), parseMode(ctx.string("mode"))), ctx.rng) : undefined;
  const { combat, result } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      const existing = cb.combatants.find((x) => x.characterId === c.id);
      if (existing) removeCombatant(cb, existing.id);
      const x = addCombatant(cb, {
        name: c.name,
        initBonus: bonus,
        initiative: manual ?? rolled!.total,
        isPlayer: true,
        hp: c.hp,
        maxHp: c.maxHp,
        ac: c.ac,
        ownerId: ctx.userId,
        characterId: c.id,
        conditions: [...c.conditions],
      });
      pushLog(cb, `${x.name} joined with initiative ${x.initiative}.`);
      return x;
    },
    ctx.now(),
  );
  const how = rolled ? `rolled **${rolled.total}** (${rolled.notation})` : `set initiative **${manual}**`;
  return trackerReply(combat, { note: `**${result.name}** ${how}.` });
}

async function add(ctx: Ctx): Promise<Reply> {
  const name = ctx.requireString("name");
  const count = ctx.integer("count") ?? 1;
  const bonus = ctx.integer("bonus") ?? 0;
  const manual = ctx.integer("initiative");
  const hp = ctx.integer("hp");
  const ac = ctx.integer("ac");
  const isPlayer = ctx.boolean("player") ?? false;
  const { combat, result } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      const added: Combatant[] = [];
      for (let i = 0; i < count; i++) {
        const base: Parameters<typeof addCombatant>[1] = { name: count > 1 ? `${name} ${String.fromCharCode(65 + i)}` : name, initBonus: bonus, isPlayer };
        if (manual !== undefined) base.initiative = manual;
        if (hp !== undefined) Object.assign(base, { hp, maxHp: hp });
        if (ac !== undefined) base.ac = ac;
        added.push(addCombatant(cb, base, ctx.rng));
      }
      pushLog(cb, `Added ${added.map((x) => `${x.name} (${x.initiative})`).join(", ")}.`);
      return added;
    },
    ctx.now(),
  );
  return trackerReply(combat, { note: `Added ${result.map((x) => `**${x.name}**`).join(", ")}.` });
}

async function monster(ctx: Ctx): Promise<Reply> {
  const q = ctx.requireString("name");
  const m = MONSTERS.find((x) => x.id === q) ?? findMonster(q);
  if (!m) throw new UserError(`No SRD monster matches "${q}". Use \`/init add\` for custom creatures.`);
  const count = ctx.integer("count") ?? 1;
  const label = ctx.string("label");
  const { combat, result } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      const added = addMonsters(cb, m, count, {
        rollHp: !(ctx.boolean("average_hp") ?? false),
        ...(ctx.rng ? { rng: ctx.rng } : {}),
        ...(label ? { name: label } : {}),
      });
      pushLog(cb, `${added.length}× ${m.name} joined the fight.`);
      return added;
    },
    ctx.now(),
  );
  return trackerReply(combat, { note: `🐉 Added ${result.length}× **${m.name}** (CR ${crText(m.cr)}, AC ${m.ac}).` });
}

async function step(ctx: Ctx, dir: "next" | "prev"): Promise<Combat> {
  const { combat } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      if (!cb.combatants.length) throw new UserError("Add some combatants first.");
      const who = dir === "next" ? nextTurn(cb) : prevTurn(cb);
      if (who && dir === "next") pushLog(cb, `Round ${cb.round}: ${who.name}'s turn.`);
    },
    ctx.now(),
  );
  return combat;
}

/** Applies HP changes to a combatant, and to the linked character sheet for players. */
async function changeHp(ctx: Ctx, kind: "damage" | "heal"): Promise<Reply> {
  const targetName = ctx.requireString("target");
  const amount = ctx.requireInteger("amount");
  const { combat, result: target } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      const t = findCombatant(cb, targetName);
      if (!t) throw new UserError(`No combatant called "${targetName}".`);
      if (t.hp === undefined) throw new UserError(`${t.name} has no HP tracked. Re-add them with the \`hp\` option.`);
      if (kind === "damage") damageCombatant(t, amount);
      else healCombatant(t, amount);
      pushLog(cb, `${t.name} ${kind === "damage" ? `took ${amount} damage` : `healed ${amount}`}${isDown(t) ? " and is down!" : "."}`);
      return t;
    },
    ctx.now(),
  );
  if (target.characterId && target.ownerId) {
    await editCharacter(
      ctx.store,
      { guildId: combat.guildId, ownerId: target.ownerId, id: target.characterId },
      (c) => (kind === "damage" ? applyDamage(c, amount) : heal(c, amount)),
      ctx.now(),
    ).catch(() => undefined);
  }
  const verb = kind === "damage" ? `🩸 **${target.name}** takes **${amount}** damage` : `💚 **${target.name}** heals **${amount}**`;
  return trackerReply(combat, { note: `${verb}${isDown(target) ? " — **down!**" : "."}` });
}

async function condition(ctx: Ctx): Promise<Reply> {
  const targetName = ctx.requireString("target");
  const cond = ctx.requireString("condition");
  const remove = ctx.boolean("remove") ?? false;
  const { combat, result } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      const t = findCombatant(cb, targetName);
      if (!t) throw new UserError(`No combatant called "${targetName}".`);
      t.conditions = t.conditions.filter((x) => x.toLowerCase() !== cond.toLowerCase());
      if (!remove) t.conditions.push(cond);
      return t;
    },
    ctx.now(),
  );
  return trackerReply(combat, { note: `**${result.name}** ${remove ? "is no longer" : "is now"} _${cond}_.` });
}

async function removeCmd(ctx: Ctx): Promise<Reply> {
  const targetName = ctx.requireString("target");
  const { combat, result } = await editCombat(
    ctx.store,
    ctx.channelId,
    (cb) => {
      const t = findCombatant(cb, targetName);
      if (!t) throw new UserError(`No combatant called "${targetName}".`);
      removeCombatant(cb, t.id);
      return t;
    },
    ctx.now(),
  );
  return trackerReply(combat, { note: `Removed **${result.name}**.` });
}

async function end(ctx: Ctx): Promise<Reply> {
  const combat = await getCombat(ctx.store, ctx.channelId);
  if (!combat) throw new UserError("There's no combat in this channel.");
  await ctx.store.delete(keys.combat(ctx.channelId));
  const survivors = combat.combatants.filter((x) => !isDown(x)).map((x) => x.name);
  return {
    embeds: [
      embed({
        title: "🏁 Combat over",
        description: `Lasted **${combat.round}** round${combat.round === 1 ? "" : "s"}.\nStill standing: ${survivors.join(", ") || "nobody…"}`,
        color: COLORS.success,
      }),
    ],
  };
}

export const initCommand: CommandModule = {
  names: ["init"],
  async run(ctx) {
    switch (ctx.subcommand) {
      case "start":
        return start(ctx);
      case "join":
        return join(ctx);
      case "add":
        return add(ctx);
      case "monster":
        return monster(ctx);
      case "next":
        return trackerReply(await step(ctx, "next"));
      case "prev":
        return trackerReply(await step(ctx, "prev"));
      case "show": {
        const combat = await getCombat(ctx.store, ctx.channelId);
        if (!combat) throw new UserError("There's no combat in this channel. Start one with `/init start`.");
        const priv = ctx.boolean("private") ?? false;
        return trackerReply(combat, { revealHp: priv, ephemeral: priv });
      }
      case "damage":
        return changeHp(ctx, "damage");
      case "heal":
        return changeHp(ctx, "heal");
      case "condition":
        return condition(ctx);
      case "remove":
        return removeCmd(ctx);
      case "end":
        return end(ctx);
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
  async autocomplete(ctx) {
    const f = ctx.focused;
    if (!f) return [];
    if (f.name === "name" && ctx.subcommand === "monster") {
      return searchByName(MONSTERS, f.value, 25).map((m) => choice(`${m.name} (CR ${crText(m.cr)}, ${m.hp} HP)`, m.id));
    }
    if (f.name === "condition") {
      return searchByName(CONDITIONS, f.value, 25).map((c) => choice(c.name));
    }
    if (f.name === "target") {
      const combat = await getCombat(ctx.store, ctx.channelId);
      const q = f.value.toLowerCase();
      return (combat?.combatants ?? [])
        .filter((x) => x.name.toLowerCase().includes(q))
        .slice(0, 25)
        .map((x) => choice(`${x.name}${isDown(x) ? " (down)" : ""}`, x.name));
    }
    return [];
  },
};

export const initButtons: ComponentModule = {
  prefix: "init",
  async run(ctx, [action]) {
    if (action === "end") {
      const reply = await end(ctx);
      return { ...reply, components: [], update: true };
    }
    const combat = await getCombat(ctx.store, ctx.channelId);
    if (!combat) return { content: "This combat has ended.", embeds: [], components: [], update: true };
    if (action === "next" || action === "prev") return { ...trackerReply(await step(ctx, action)), update: true };
    return { ...trackerReply(combat), update: true };
  },
};
