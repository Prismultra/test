import { applyDamage, heal, hpBar, longRest, mod, setTempHp, shortRest, hitDie, type Character } from "../game/character.js";
import { COLORS, UserError, embed, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { editCharacter, requireActive } from "./characters.js";
import { syncCharacterToCombat } from "./combat-store.js";
import type { CommandModule } from "./registry.js";
import { rollLine } from "./views.js";

const hpText = (c: Character) => `${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} temp)` : ""}\n${hpBar(c.hp, c.maxHp)}`;

async function finish(ctx: Ctx, c: Character, title: string, note: string, color: number = COLORS.brand): Promise<Reply> {
  await syncCharacterToCombat(ctx.store, ctx.channelId, c).catch(() => undefined);
  return {
    embeds: [embed({ title, author: ctx.userName, description: [note, hpText(c)].filter(Boolean).join("\n"), color })],
  };
}

export const hpCommand: CommandModule = {
  names: ["hp"],
  async run(ctx) {
    const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    switch (ctx.subcommand) {
      case "damage": {
        const amount = ctx.requireInteger("amount");
        const { char, result } = await editCharacter(
          ctx.store,
          active,
          (c) => applyDamage(c, amount, { critical: ctx.boolean("crit") ?? false }),
          ctx.now(),
        );
        const notes = [`Took **${amount}** damage${result.absorbedByTemp ? ` (${result.absorbedByTemp} absorbed by temp HP)` : ""}.`];
        if (result.instantDeath) notes.push("☠️ **Massive damage** — that's instant death unless the DM rules otherwise.");
        else if (result.droppedToZero) notes.push("💀 **Down!** Roll death saves with `/deathsave` on your turns.");
        if (result.deathSaveFailures) notes.push(`❌ Damage at 0 HP: **${result.deathSaveFailures}** death save failure(s) (${char.deathSaves.failures}/3).`);
        return finish(ctx, char, `🩸 ${char.name}`, notes.join("\n"), COLORS.danger);
      }
      case "heal": {
        const amount = ctx.requireInteger("amount");
        const { char, result } = await editCharacter(ctx.store, active, (c) => heal(c, amount), ctx.now());
        return finish(ctx, char, `💚 ${char.name}`, `Regained **${result}** HP.`, COLORS.success);
      }
      case "temp": {
        const amount = ctx.requireInteger("amount");
        const { char } = await editCharacter(ctx.store, active, (c) => setTempHp(c, amount), ctx.now());
        return finish(ctx, char, `🛡️ ${char.name}`, `Temporary HP is now **${char.tempHp}** (temp HP doesn't stack).`);
      }
      case "set": {
        const amount = ctx.requireInteger("amount");
        const { char } = await editCharacter(
          ctx.store,
          active,
          (c) => {
            c.hp = Math.min(c.maxHp, amount);
            if (c.hp > 0) c.deathSaves = { successes: 0, failures: 0 };
          },
          ctx.now(),
        );
        return finish(ctx, char, `✏️ ${char.name}`, "");
      }
      case "show":
        return { embeds: [embed({ title: `❤️ ${active.name}`, description: hpText(active) })], ephemeral: true };
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
};

export const restCommand: CommandModule = {
  names: ["rest"],
  async run(ctx) {
    const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    if (ctx.requireString("type") === "long") {
      const { char } = await editCharacter(ctx.store, active, (c) => longRest(c), ctx.now());
      return finish(
        ctx,
        char,
        `🌙 ${char.name} takes a long rest`,
        `HP restored, spell slots recovered, ${char.level - char.hitDiceUsed}/${char.level} hit dice available.`,
        COLORS.success,
      );
    }
    const want = ctx.integer("hit_dice") ?? 0;
    const { char, result } = await editCharacter(ctx.store, active, (c) => shortRest(c, want, ctx.rng), ctx.now());
    const lines: string[] = [];
    if (want > 0 && result.spent === 0) lines.push("No hit dice left to spend.");
    if (result.spent > 0) {
      const con = mod(char, "con");
      lines.push(
        `Spent **${result.spent}** hit dice (d${hitDie(char)}${con ? ` ${con > 0 ? "+" : "-"} ${Math.abs(con)} CON` : ""} each):`,
        ...result.rolls.map((r) => `• ${rollLine(r)}`),
        `Regained **${result.healed}** HP.`,
      );
    }
    lines.push(`${char.level - char.hitDiceUsed}/${char.level} hit dice left.`);
    if (char.pact) lines.push("Pact Magic slots recovered.");
    return finish(ctx, char, `☕ ${char.name} takes a short rest`, lines.join("\n"), COLORS.success);
  },
};
