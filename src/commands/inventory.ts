import { addItem, adjustCoins, coinsText, removeItem, type Coins } from "../game/character.js";
import { MAGIC_ITEMS, WEAPONS, ARMOR, searchByName } from "../srd/index.js";
import { COLORS, UserError, embed } from "../discord/ui.js";
import { editCharacter, getActive, requireActive } from "./characters.js";
import { choice, type CommandModule } from "./registry.js";

export const inventoryCommand: CommandModule = {
  names: ["inv"],
  async run(ctx) {
    const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
    switch (ctx.subcommand) {
      case "list": {
        const items = active.inventory.map((i) => `• ${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`);
        return {
          embeds: [
            embed({
              title: `🎒 ${active.name}'s inventory`,
              description: `💰 ${coinsText(active.coins)}\n\n${items.length ? items.join("\n") : "_Empty._"}`,
              color: COLORS.brand,
            }),
          ],
          ephemeral: true,
        };
      }
      case "add": {
        const name = ctx.requireString("item");
        const qty = ctx.integer("qty") ?? 1;
        const { char, result } = await editCharacter(
          ctx.store,
          active,
          (c) => {
            if (c.inventory.length >= 100) throw new UserError("Inventory is full (100 different items).");
            return addItem(c, name, qty);
          },
          ctx.now(),
        );
        return { content: `🎒 **${char.name}** added ${qty > 1 ? `${qty}× ` : ""}**${name}** (now ${result.qty}).` };
      }
      case "remove": {
        const name = ctx.requireString("item");
        const qty = ctx.integer("qty") ?? 1;
        const { char, result } = await editCharacter(ctx.store, active, (c) => removeItem(c, name, qty), ctx.now());
        if (!result) throw new UserError(`${char.name} isn't carrying "${name}".`);
        return { content: `🎒 **${char.name}** removed ${result.removed}× **${name}**${result.left ? ` (${result.left} left)` : ""}.` };
      }
      case "coins": {
        const delta: Partial<Coins> = {};
        for (const k of ["pp", "gp", "sp", "cp"] as const) {
          const v = ctx.integer(k);
          if (v) delta[k] = v;
        }
        if (!Object.keys(delta).length) throw new UserError("Give an amount, e.g. `gp: 25` or `sp: -3`.");
        const { char, result } = await editCharacter(ctx.store, active, (c) => adjustCoins(c, delta), ctx.now());
        if (!result) throw new UserError(`${char.name} can't afford that (has ${coinsText(char.coins)}).`);
        const change = Object.entries(delta)
          .map(([k, v]) => `${v! > 0 ? "+" : ""}${v} ${k}`)
          .join(", ");
        return { content: `💰 **${char.name}**: ${change} → ${coinsText(char.coins)}` };
      }
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
  async autocomplete(ctx) {
    const q = ctx.focused?.value ?? "";
    if (ctx.subcommand === "remove") {
      const c = await getActive(ctx.store, ctx.guildId, ctx.userId);
      return (c?.inventory ?? [])
        .filter((i) => i.name.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 25)
        .map((i) => choice(`${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`, i.name));
    }
    const suggestions = [...WEAPONS, ...ARMOR, ...MAGIC_ITEMS];
    const hits = q ? searchByName(suggestions, q, 24).map((x) => choice(x.name)) : [];
    if (q && !hits.some((h) => h.value.toLowerCase() === q.toLowerCase())) hits.unshift(choice(q));
    return hits.slice(0, 25);
  },
};
