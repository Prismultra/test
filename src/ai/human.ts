// Tools for a human Dungeon Master: a private overview of everything, and a way
// to narrate that's saved to the story so the AI can pick up later.
import type { Character } from "../game/character.js";
import { coinsText, hpBar, passivePerception, saveBonus, skillBonus, spellSaveDc } from "../game/character.js";
import { current, renderOrder } from "../game/combat.js";
import { ABILITIES, SKILLS, abilityMod, signed } from "../game/rules.js";
import { COLORS, UserError, chunkText, embed, truncate, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { getCombat } from "../commands/combat-store.js";
import type { CommandModule } from "../commands/registry.js";
import { slotsText } from "../commands/views.js";
import { editCampaign, isHumanRun, newId, requireCampaign, type Campaign } from "./campaign.js";
import { loadParty } from "./dm.js";
import { transcriptLine } from "./prompt.js";

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

/** The campaign's creator, or someone who can manage the server. */
export function canManage(ctx: Ctx, campaign: Campaign): boolean {
  if (ctx.userId === campaign.createdBy) return true;
  const perms = ctx.interaction.member?.permissions;
  if (!perms) return false;
  return (BigInt(perms) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
}

/** One compact block per character with what a DM needs at a glance. */
export function dmCharacterSummary(c: Character): string {
  const mods = ABILITIES.map((a) => `${a.toUpperCase()} ${signed(abilityMod(c.abilities[a]))}`).join(" ");
  const saves = c.saveProfs.map((a) => `${a.toUpperCase()} ${signed(saveBonus(c, a))}`).join(", ");
  const skills = c.skillProfs.map((s) => `${SKILLS[s].name} ${signed(skillBonus(c, s))}`).join(", ");
  const dc = spellSaveDc(c);
  const lines = [
    `${hpBar(c.hp, c.maxHp, 8)} **${c.hp}/${c.maxHp}**${c.tempHp ? ` +${c.tempHp} temp` : ""} · AC **${c.ac}** · Speed ${c.speed} · PP ${passivePerception(c)}`,
    `${mods}`,
    saves && `Saves: ${saves}`,
    skills && `Skills: ${skills}`,
    c.attacks.length ? `Attacks: ${c.attacks.map((a) => `${a.name} ${signed(a.toHit)} (${a.damage})`).join("; ")}` : "",
    dc !== undefined || c.pact ? `Spells: DC ${dc ?? "—"} · ${slotsText(c) || "no slots left"}` : "",
    c.conditions.length ? `⚠️ ${c.conditions.join(", ")}` : "",
    c.hp === 0 ? `💀 Death saves: ${c.deathSaves.successes}✅ ${c.deathSaves.failures}❌` : "",
    c.inventory.length || c.coins.gp || c.coins.sp || c.coins.cp || c.coins.pp
      ? `🎒 ${coinsText(c.coins)}${c.inventory.length ? ` · ${truncate(c.inventory.map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)).join(", "), 300)}` : ""}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export const groupStatusCommand: CommandModule = {
  names: ["group-status"],
  async run(ctx) {
    const c = await requireCampaign(ctx.store, ctx.channelId);
    const isDm = isHumanRun(c) && c.humanDm!.userId === ctx.userId;
    if (!isDm && !canManage(ctx, c)) {
      const who = isHumanRun(c) ? `<@${c.humanDm!.userId}>` : "the DM";
      throw new UserError(`Only the Dungeon Master (${who}) can see the full picture. Try \`/dm status\`.`);
    }
    const party = await loadParty(ctx.store, c);
    const combat = await getCombat(ctx.store, ctx.channelId);

    const overview = embed({
      title: `🧙 ${c.title ?? "Untitled adventure"} — DM view`,
      description: [
        c.premise ? `_${truncate(c.premise, 400)}_` : "",
        `📍 **Scene:** ${c.scene ?? "—"}`,
        `🎯 **Quest:** ${c.quest ?? "—"}`,
        `🗒️ ${c.turns} turns so far${isHumanRun(c) ? ` · DM: ${c.humanDm!.userName}` : " · DM: the AI"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      color: COLORS.narration,
      fields: party.length
        ? party.map((p) => ({ name: `${p.character.name} — ${p.playerName} · L${p.character.level} ${p.character.className}`, value: dmCharacterSummary(p.character) }))
        : [{ name: "Party", value: "_Nobody has joined yet._" }],
    });

    const story = embed({
      title: "📖 Story so far",
      description: c.summary || "_No summary yet — see the recent events below._",
      color: COLORS.info,
      fields: [
        { name: "🗒️ Notes", value: c.notes.length ? truncate(c.notes.map((n) => `• ${n}`).join("\n"), 1024) : "_None yet._" },
        {
          name: "🕰️ Recent events",
          value: c.transcript.length
            ? truncate(
                c.transcript
                  .slice(-8)
                  .map((e) => truncate(transcriptLine(e), 400))
                  .join("\n"),
                1024,
              )
            : "_Nothing yet._",
        },
      ],
    });

    const extras: string[] = [];
    if (combat) {
      const who = current(combat);
      extras.push(`**⚔️ Combat — round ${combat.round}${who ? `, ${who.name}'s turn` : ""}**\n${renderOrder(combat, { revealHp: true })}`);
    }
    const waiting = c.pendingRolls.filter((r) => !r.result);
    const made = c.pendingRolls.filter((r) => r.result);
    if (waiting.length) extras.push(`**🎲 Rolls still to make**\n${waiting.map((r) => `• ${r.characterName}: ${r.label}${r.dc !== undefined ? ` (DC ${r.dc})` : ""} — ${r.reason}`).join("\n")}`);
    if (made.length) extras.push(`**✅ Rolls made**\n${made.map((r) => `• ${r.result!.text}`).join("\n")}`);
    if (c.queue.length) extras.push(`**⏳ Actions waiting**\n${c.queue.filter((a) => !a.wake).map((a) => `• ${a.characterName}: ${a.text}`).join("\n")}`);

    const followups: Reply[] = [{ embeds: [story], ephemeral: true }];
    if (extras.length) {
      for (const chunk of chunkText(extras.join("\n\n"), 4000)) {
        followups.push({ embeds: [embed({ description: chunk, color: COLORS.danger })], ephemeral: true });
      }
    }
    return { embeds: [overview], ephemeral: true, followups };
  },
};

export const narrateCommand: CommandModule = {
  names: ["narrate"],
  async run(ctx) {
    const text = ctx.requireString("text");
    const scene = ctx.string("scene")?.trim();
    const c = await requireCampaign(ctx.store, ctx.channelId);
    if (!isHumanRun(c) || c.humanDm!.userId !== ctx.userId) {
      throw new UserError(
        isHumanRun(c)
          ? `Only the Dungeon Master (<@${c.humanDm!.userId}>) can narrate.`
          : "The AI is running this campaign. Start a vote for a human DM with `/dm vote`.",
      );
    }
    const at = ctx.now().toISOString();
    const { campaign } = await editCampaign(
      ctx.store,
      ctx.channelId,
      (cur) => {
        cur.transcript.push({ id: newId(), kind: "dm", author: cur.humanDm?.userName ?? ctx.userName, text, at });
        cur.turns++;
        if (scene) cur.scene = scene.slice(0, 200);
      },
      ctx.now(),
    );
    const ping = ctx.boolean("ping") ?? false;
    const reply: Reply = {
      embeds: [
        embed({
          author: `🧙 ${ctx.userName} · Dungeon Master`,
          description: text,
          color: COLORS.narration,
          ...(campaign.scene ? { footer: `📍 ${campaign.scene}` } : {}),
        }),
      ],
    };
    if (ping) {
      const players = campaign.party.map((p) => p.userId).filter((u) => u !== ctx.userId);
      reply.content = players.map((u) => `<@${u}>`).join(" ");
      reply.mentionUsers = players;
    }
    return reply;
  },
};
