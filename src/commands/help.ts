import { SRD_ATTRIBUTION } from "../srd/index.js";
import { COLORS, embed } from "../discord/ui.js";
import type { CommandModule } from "./registry.js";

export const helpCommand: CommandModule = {
  names: ["help"],
  async run(ctx) {
    const aiOn = Boolean(ctx.deps.dm);
    return {
      embeds: [
        embed({
          title: "🍺 Tavernkeep",
          description: "Your table's dice roller, character sheets, combat tracker and (optionally) AI Dungeon Master.",
          color: COLORS.brand,
          fields: [
            {
              name: "🎲 Dice",
              value: "`/roll 2d6+3` · `/roll 1d20+5 adv` · `/roll 4d6dl1 repeat:6` · `/roll 8d6 fire`\nKeep/drop: `kh` `kl` `dh` `dl` · explode `!` · reroll low `ro1`",
            },
            {
              name: "🧙 Characters",
              value:
                "`/char create` · `/char sheet` · `/char set` · `/char prof` · `/char attack-add`\n`/check stealth` · `/save dex` · `/attack longsword` · `/hp damage` · `/rest long` · `/deathsave`\n`/spell cast` · `/spell slots` · `/inv add` · `/inv coins`",
            },
            {
              name: "⚔️ Combat",
              value: "`/init start` → players `/init join`, DM `/init monster goblin count:4` → use the ▶️ button.\n`/attack name target:` hits and applies damage automatically.",
            },
            { name: "📚 Rules lookups (SRD 5.1)", value: "`/monster` · `/spell info` · `/condition` · `/item`" },
            {
              name: "🐉 AI Dungeon Master",
              value: aiOn
                ? "`/dm start` to begin a campaign in this channel, `/dm join` to bring your character, then `/act` to play.\nWhen the DM asks for a roll, click the button. `/dm ask` for out-of-character questions."
                : "_Not enabled on this server. The bot owner can turn it on by adding an Anthropic API key._",
            },
          ],
          footer: SRD_ATTRIBUTION,
        }),
      ],
      ephemeral: true,
    };
  },
};
