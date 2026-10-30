import { DiceError, extractMode, roll, type RollMode } from "../game/dice.js";
import { COLORS, embed, UserError } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import type { CommandModule } from "./registry.js";
import { rollEmbed, rollLine } from "./views.js";

export const parseMode = (v: string | undefined): RollMode =>
  v === "advantage" || v === "disadvantage" ? v : "normal";

export function safeRoll(expression: string, opts: Parameters<typeof roll>[1] = {}) {
  try {
    return roll(expression, opts);
  } catch (err) {
    if (err instanceof DiceError) throw new UserError(err.message);
    throw err;
  }
}

export const rollCommand: CommandModule = {
  names: ["roll"],
  async run(ctx: Ctx) {
    const raw = ctx.requireString("dice");
    const extracted = extractMode(raw);
    const mode = ctx.has("mode") ? parseMode(ctx.string("mode")) : extracted.mode;
    const repeat = ctx.integer("repeat") ?? 1;
    const reason = ctx.string("reason");
    const ephemeral = ctx.boolean("private") ?? false;
    const opts = ctx.rng ? { mode, rng: ctx.rng } : { mode };

    if (repeat === 1) {
      const result = safeRoll(extracted.expression, opts);
      return {
        embeds: [rollEmbed({ title: reason ? `🎲 ${reason}` : "🎲 Roll", result, author: ctx.userName })],
        ephemeral,
      };
    }

    const results = Array.from({ length: repeat }, () => safeRoll(extracted.expression, opts));
    const lines = results.map((r, i) => `\`${String(i + 1).padStart(2)}\` ${rollLine(r)}`);
    const sum = results.reduce((s, r) => s + r.total, 0);
    return {
      embeds: [
        embed({
          title: `🎲 ${reason ?? `${results[0]!.notation} × ${repeat}`}`,
          author: ctx.userName,
          description: `${lines.join("\n")}\n\nSum **${sum}**`,
          color: COLORS.brand,
        }),
      ],
      ephemeral,
    };
  },
};
