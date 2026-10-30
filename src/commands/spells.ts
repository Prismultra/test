import { mod, spellAttackBonus, spellSaveDc, spellcastingAbility, useSpellSlot } from "../game/character.js";
import { ordinal, signed } from "../game/rules.js";
import { findSpell } from "../srd/index.js";
import { COLORS, UserError, embed } from "../discord/ui.js";
import { editCharacter, requireActive } from "./characters.js";
import type { CommandModule } from "./registry.js";
import { spellLookupChoices } from "./lookup.js";
import { slotsText, spellEmbed } from "./views.js";

export const spellCommand: CommandModule = {
  names: ["spell"],
  async run(ctx) {
    switch (ctx.subcommand) {
      case "info": {
        const name = ctx.requireString("name");
        const s = findSpell(name);
        if (!s) throw new UserError(`No SRD spell matches "${name}".`);
        return { embeds: [spellEmbed(s)], ephemeral: ctx.boolean("private") ?? false };
      }
      case "cast": {
        const level = ctx.requireInteger("level");
        const name = ctx.string("name");
        const srd = name ? findSpell(name) : undefined;
        if (srd && srd.level > level && level > 0) {
          throw new UserError(`${srd.name} needs at least a ${ordinal(srd.level)}-level slot.`);
        }
        const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
        const spellName = srd?.name ?? name ?? "a spell";
        if (level === 0) {
          return {
            embeds: [
              embed({
                title: `✨ ${active.name} casts ${spellName}`,
                author: ctx.userName,
                description: castDetails(active, srd),
                color: COLORS.info,
              }),
            ],
          };
        }
        const { char, result } = await editCharacter(ctx.store, active, (c) => useSpellSlot(c, level), ctx.now());
        if (!result.ok) throw new UserError(result.reason);
        const slotNote = result.pact
          ? `Used a Pact Magic slot (${ordinal(result.slotLevel)} level).`
          : `Used a ${ordinal(result.slotLevel)}-level slot.`;
        return {
          embeds: [
            embed({
              title: `✨ ${char.name} casts ${spellName}${srd && level > srd.level ? ` at ${ordinal(level)} level` : ""}`,
              author: ctx.userName,
              description: [slotNote, castDetails(char, srd, level), `**Slots:** ${slotsText(char) || "none"}`]
                .filter(Boolean)
                .join("\n"),
              color: COLORS.info,
            }),
          ],
        };
      }
      case "slots": {
        const c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
        const dc = spellSaveDc(c);
        const lines = [slotsText(c) || "_No spell slots._"];
        if (dc !== undefined) lines.unshift(`Save DC **${dc}** · Spell attack **${signed(spellAttackBonus(c) ?? 0)}**`);
        return { embeds: [embed({ title: `✨ ${c.name}'s spell slots`, description: lines.join("\n"), color: COLORS.info })], ephemeral: true };
      }
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
  async autocomplete(ctx) {
    return spellLookupChoices(ctx.focused?.value ?? "");
  },
};

function castDetails(
  c: Parameters<typeof spellSaveDc>[0],
  srd: ReturnType<typeof findSpell>,
  slot?: number,
): string {
  if (!srd) return "";
  const parts: string[] = [];
  const dc = spellSaveDc(c);
  if (srd.save && dc !== undefined) parts.push(`Targets make a **${srd.save}** save vs DC **${dc}**.`);
  if (srd.attackType) parts.push(`Make a ${srd.attackType} spell attack: \`/roll 1d20${signed(spellAttackBonus(c) ?? 0)}\``);
  const dmg = slot && srd.damageAtSlot?.[String(slot)];
  const cantripDmg = srd.damageAtCharLevel
    ? Object.entries(srd.damageAtCharLevel)
        .filter(([lvl]) => Number(lvl) <= c.level)
        .pop()?.[1]
    : undefined;
  // SRD formulas use "MOD" for the spellcasting ability modifier.
  const ability = spellcastingAbility(c);
  const withMod = (f: string) => f.replace(/\s*\+\s*MOD/g, ability ? signed(mod(c, ability)).replace("+", " + ").replace("-", " - ") : "");
  const dice = dmg || cantripDmg;
  if (dice) parts.push(`Damage: \`/roll ${withMod(dice).replace(/\s+/g, "")}${srd.damageType ? ` ${srd.damageType}` : ""}\``);
  const healing = slot && srd.healAtSlot?.[String(slot)];
  if (healing) parts.push(`Healing: \`/roll ${withMod(healing).replace(/\s+/g, "")}\``);
  parts.push(`_${srd.castingTime} · ${srd.range} · ${srd.duration}_`);
  return parts.join("\n");
}
