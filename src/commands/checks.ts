import { applyDamage, isDead, isStable, mod, rollCheck, rollDeathSave, rollSave, skillBonus, type Character } from "../game/character.js";
import { applyMode, critical, evaluate, parse, totalsByLabel } from "../game/dice.js";
import { damageCombatant, findCombatant, isDown, pushLog } from "../game/combat.js";
import { ABILITIES, ABILITY_NAMES, SKILL_KEYS, SKILLS, parseAbility, parseSkill, signed } from "../game/rules.js";
import { COLORS, UserError, embed } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { editCharacter, requireActive } from "./characters.js";
import { editCombat, getCombat, syncCharacterToCombat } from "./combat-store.js";
import { choice, type CommandModule } from "./registry.js";
import { parseMode } from "./roll.js";
import { natNote, rollColor, rollEmbed, rollLine } from "./views.js";

const rngOpt = (ctx: Ctx) => (ctx.rng ? { rng: ctx.rng } : {});

export const checkCommand: CommandModule = {
  names: ["check"],
  async run(ctx) {
    const c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    const what = ctx.requireString("skill");
    const skill = parseSkill(what);
    const ability = skill ? undefined : parseAbility(what);
    if (!skill && !ability) throw new UserError(`"${what}" isn't a skill or ability.`);
    const bonus = ctx.integer("bonus");
    const out = rollCheck(c, skill ? { skill } : { ability: ability! }, {
      mode: parseMode(ctx.string("mode")),
      ...(bonus !== undefined ? { bonus } : {}),
      ...rngOpt(ctx),
    });
    const title = skill ? `${c.name} — ${SKILLS[skill].name} check` : `${c.name} — ${ABILITY_NAMES[ability!]} check`;
    const dc = ctx.integer("dc");
    return {
      embeds: [rollEmbed({ title: `🎲 ${title}`, result: out.roll, author: ctx.userName, ...(dc !== undefined ? { dc } : {}) })],
      ephemeral: ctx.boolean("private") ?? false,
    };
  },
  async autocomplete(ctx) {
    const q = (ctx.focused?.value ?? "").toLowerCase();
    let c: Character | undefined;
    try {
      c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    } catch {
      c = undefined;
    }
    const skills = SKILL_KEYS.map((k) =>
      choice(`${SKILLS[k].name}${c ? ` (${signed(skillBonus(c, k))})` : ` (${SKILLS[k].ability.toUpperCase()})`}`, k),
    );
    const abilities = ABILITIES.map((a) => choice(`${ABILITY_NAMES[a]} check${c ? ` (${signed(mod(c, a))})` : ""}`, a));
    return [...skills, ...abilities].filter((x) => x.name.toLowerCase().includes(q)).slice(0, 25);
  },
};

export const saveCommand: CommandModule = {
  names: ["save"],
  async run(ctx) {
    const c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    const ability = parseAbility(ctx.requireString("ability"));
    if (!ability) throw new UserError("Pick an ability.");
    const bonus = ctx.integer("bonus");
    const out = rollSave(c, ability, {
      mode: parseMode(ctx.string("mode")),
      ...(bonus !== undefined ? { bonus } : {}),
      ...rngOpt(ctx),
    });
    const dc = ctx.integer("dc");
    return {
      embeds: [
        rollEmbed({
          title: `🛡️ ${c.name} — ${ABILITY_NAMES[ability]} saving throw`,
          result: out.roll,
          author: ctx.userName,
          ...(dc !== undefined ? { dc } : {}),
        }),
      ],
      ephemeral: ctx.boolean("private") ?? false,
    };
  },
};

export const attackCommand: CommandModule = {
  names: ["attack"],
  async run(ctx) {
    const c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    const name = ctx.requireString("name").toLowerCase();
    const atk = c.attacks.find((a) => a.name.toLowerCase() === name) ?? c.attacks.find((a) => a.name.toLowerCase().startsWith(name));
    if (!atk) {
      throw new UserError(
        c.attacks.length
          ? `${c.name} has no attack called "${name}".`
          : `${c.name} has no attacks yet. Add one with \`/char attack-add\`.`,
      );
    }
    const toHit = atk.toHit + (ctx.integer("bonus") ?? 0);
    const mode = parseMode(ctx.string("mode"));
    const hitRoll = evaluate(applyMode(parse(`1d20${toHit >= 0 ? "+" : ""}${toHit}`), mode), ctx.rng);
    const isCrit = hitRoll.natural === 20;
    const isFumble = hitRoll.natural === 1;
    const dmgTerms = parse(atk.damage);
    const dmg = evaluate(isCrit ? critical(dmgTerms) : dmgTerms, ctx.rng);
    const byType = Object.entries(totalsByLabel(dmg))
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${v}${k ? ` ${k}` : ""}`)
      .join(" + ");

    const lines = [
      `**To hit:** \`${hitRoll.notation}\` → ${rollLine(hitRoll)}`,
      natNote(hitRoll),
      `**Damage${isCrit ? " (critical!)" : ""}:** \`${dmg.notation}\` → ${rollLine(dmg)}${byType && byType !== String(dmg.total) ? ` (${byType})` : ""}`,
    ];

    const targetName = ctx.string("target");
    if (targetName) lines.push(await resolveAgainstTarget(ctx, targetName, c.name, hitRoll.total, isCrit, isFumble, dmg.total));

    return {
      embeds: [
        embed({
          title: `⚔️ ${c.name} attacks with ${atk.name}`,
          author: ctx.userName,
          description: lines.filter(Boolean).join("\n"),
          color: rollColor(hitRoll),
          ...(atk.notes ? { footer: atk.notes } : {}),
        }),
      ],
    };
  },
  async autocomplete(ctx) {
    const f = ctx.focused;
    if (!f) return [];
    const q = f.value.toLowerCase();
    if (f.name === "target") {
      const combat = await getCombat(ctx.store, ctx.channelId);
      return (combat?.combatants ?? [])
        .filter((x) => x.name.toLowerCase().includes(q) && !isDown(x))
        .slice(0, 25)
        .map((x) => choice(x.name));
    }
    try {
      const c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
      return c.attacks
        .filter((a) => a.name.toLowerCase().includes(q))
        .map((a) => choice(`${a.name} (${signed(a.toHit)}, ${a.damage})`, a.name));
    } catch {
      return [];
    }
  },
};

async function resolveAgainstTarget(
  ctx: Ctx,
  targetName: string,
  attacker: string,
  total: number,
  crit: boolean,
  fumble: boolean,
  damage: number,
): Promise<string> {
  const combat = await getCombat(ctx.store, ctx.channelId);
  const target = combat && findCombatant(combat, targetName);
  if (!combat || !target) return `🎯 Target: ${targetName}`;
  if (target.ac === undefined) return `🎯 vs **${target.name}** (unknown AC — DM decides)`;
  const hit = !fumble && (crit || total >= target.ac);
  if (!hit) {
    await editCombat(ctx.store, ctx.channelId, (c) => pushLog(c, `${attacker} missed ${target.name}.`), ctx.now());
    return `🎯 vs **${target.name}**: **Miss!**`;
  }
  const { result: hpLeft } = await editCombat(
    ctx.store,
    ctx.channelId,
    (c) => {
      const t = c.combatants.find((x) => x.id === target.id);
      if (!t) return undefined;
      const left = damageCombatant(t, damage);
      pushLog(c, `${attacker} hit ${t.name} for ${damage}.`);
      return left;
    },
    ctx.now(),
  );
  if (target.characterId && target.ownerId) {
    const { char } = await editCharacter(
      ctx.store,
      { guildId: ctx.guildId, ownerId: target.ownerId, id: target.characterId },
      (ch) => applyDamage(ch, damage, { critical: crit }),
      ctx.now(),
    ).catch(() => ({ char: undefined }));
    if (char) await syncCharacterToCombat(ctx.store, ctx.channelId, char);
  }
  const status = hpLeft === 0 ? " 💀 **Down!**" : "";
  return `🎯 vs **${target.name}**: **Hit!** ${damage} damage applied.${status}`;
}

export const deathSaveCommand: CommandModule = {
  names: ["deathsave"],
  async run(ctx) {
    const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    if (active.hp > 0) throw new UserError(`${active.name} isn't at 0 HP, so no death save needed.`);
    if (isDead(active)) throw new UserError(`${active.name} has already failed three death saves. Only magic can help now.`);
    if (isStable(active)) throw new UserError(`${active.name} is stable — no more death saves unless they take damage.`);
    const { char, result } = await editCharacter(ctx.store, active, (c) => rollDeathSave(c, ctx.rng), ctx.now());
    await syncCharacterToCombat(ctx.store, ctx.channelId, char).catch(() => undefined);
    const msg = {
      success: "✅ Success.",
      failure: "❌ Failure.",
      stable: "😮‍💨 **Stable!** Three successes — unconscious but no longer dying.",
      dead: "🪦 **Three failures.** The character has died.",
      revived: "✨ **Natural 20!** Back on their feet with 1 HP!",
    }[result.result];
    const tally = `Successes ${"✅".repeat(char.deathSaves.successes)}${"▫️".repeat(Math.max(0, 3 - char.deathSaves.successes))} · Failures ${"❌".repeat(char.deathSaves.failures)}${"▫️".repeat(Math.max(0, 3 - char.deathSaves.failures))}`;
    return {
      embeds: [
        embed({
          title: `💀 ${char.name} — death saving throw`,
          author: ctx.userName,
          description: `\`1d20\` → ${rollLine(result.roll)}\n${msg}${result.result === "success" || result.result === "failure" ? `\n${tally}` : ""}`,
          color: result.result === "dead" ? COLORS.danger : result.result === "revived" ? COLORS.crit : COLORS.brand,
        }),
      ],
    };
  },
};
