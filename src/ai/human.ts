// Tools for a human Dungeon Master: a private overview of everything, and a way
// to narrate that's saved to the story so the AI can pick up later.
import type { Character } from "../game/character.js";
import { coinsText, hpBar, passivePerception, saveBonus, skillBonus, spellSaveDc } from "../game/character.js";
import { current, renderOrder } from "../game/combat.js";
import { ABILITIES, ABILITY_NAMES, SKILLS, SKILL_KEYS, abilityMod, parseAbility, parseSkill, signed } from "../game/rules.js";
import type { RollMode } from "../game/dice.js";
import { ButtonStyle, COLORS, UserError, button, chunkText, embed, row, truncate, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { canManage } from "../commands/dm-guard.js";
export { canManage };
import { getCombat } from "../commands/combat-store.js";
import { choice, type Choice, type CommandModule } from "../commands/registry.js";
import { slotsText } from "../commands/views.js";
import { editCampaign, getCampaign, isHumanRun, newId, requireCampaign, type Campaign, type PendingRoll, type RollKind } from "./campaign.js";
import { keys } from "../store/store.js";
import { loadParty } from "./dm.js";
import { transcriptLine } from "./prompt.js";

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

/** Parses a check option: a skill, an ability, "save:dex" or "attack:Longsword". */
function parseCheck(value: string, c: Character): { kind: RollKind; key: string; label: string } {
  const v = value.trim();
  if (v.toLowerCase().startsWith("save:")) {
    const a = parseAbility(v.slice(5));
    if (a) return { kind: "save", key: a, label: `${ABILITY_NAMES[a]} save` };
  }
  if (v.toLowerCase().startsWith("attack:")) {
    const name = v.slice(7).trim().toLowerCase();
    const atk = c.attacks.find((a) => a.name.toLowerCase() === name) ?? c.attacks.find((a) => a.name.toLowerCase().startsWith(name));
    if (!atk) throw new UserError(`${c.name} has no attack called "${v.slice(7).trim()}".`);
    return { kind: "attack", key: atk.name, label: `${atk.name} attack` };
  }
  const skill = parseSkill(v);
  if (skill) return { kind: "skill", key: skill, label: SKILLS[skill].name };
  const ability = parseAbility(v.replace(/\s*check$/i, ""));
  if (ability) return { kind: "ability", key: ability, label: `${ABILITY_NAMES[ability]} check` };
  throw new UserError(`"${v}" isn't a skill, ability, save or attack. Pick one from the list.`);
}

export const requestRollCommand: CommandModule = {
  names: ["request-roll"],
  async run(ctx) {
    const c = await requireCampaign(ctx.store, ctx.channelId);
    const isDm = isHumanRun(c) && c.humanDm!.userId === ctx.userId;
    if (!isDm) {
      throw new UserError(
        isHumanRun(c)
          ? `Only the Dungeon Master (<@${c.humanDm!.userId}>) can ask for rolls.`
          : "The AI is running this campaign and asks for rolls itself. Start a vote for a human DM with `/dm vote`.",
      );
    }
    const playerId = ctx.requireString("player");
    const member = c.party.find((p) => p.userId === playerId);
    if (!member) throw new UserError("That player isn't in the party. They can join with `/dm join`.");
    const sheet = await ctx.store.get<Character>(keys.character(c.guildId, member.userId, member.characterId));
    if (!sheet) throw new UserError(`${member.characterName}'s sheet is gone.`);
    const check = parseCheck(ctx.requireString("check"), sheet.value);
    const modeOpt = ctx.string("mode");
    const mode: RollMode = modeOpt === "advantage" || modeOpt === "disadvantage" ? modeOpt : "normal";
    const reason = ctx.string("reason")?.trim() ?? "";
    const roll: PendingRoll = {
      id: newId(),
      batch: newId(),
      userId: member.userId,
      characterId: member.characterId,
      characterName: member.characterName,
      ...check,
      mode,
      reason,
    };
    const dc = ctx.integer("dc");
    if (dc !== undefined) roll.dc = dc;
    await editCampaign(ctx.store, ctx.channelId, (cur) => void cur.pendingRolls.push(roll), ctx.now());

    const modeNote = mode === "normal" ? "" : ` with **${mode}**`;
    return {
      content: `🎲 <@${member.userId}>, roll **${check.label}** for **${member.characterName}**${modeNote}!${reason ? `\n> ${reason}` : ""}`,
      components: [row(button(`dm:roll:${roll.id}`, `${member.characterName}: ${check.label}`, ButtonStyle.Primary, "🎲"))],
      mentionUsers: [member.userId],
    };
  },
  async autocomplete(ctx) {
    const q = (ctx.focused?.value ?? "").toLowerCase();
    const options: Choice[] = [
      ...SKILL_KEYS.map((k) => choice(`${SKILLS[k].name} (${SKILLS[k].ability.toUpperCase()})`, k)),
      ...ABILITIES.map((a) => choice(`${ABILITY_NAMES[a]} check`, a)),
      ...ABILITIES.map((a) => choice(`${ABILITY_NAMES[a]} saving throw`, `save:${a}`)),
    ];
    // If the player is already picked, offer their attacks too.
    const playerId = ctx.string("player");
    const c = playerId ? await getCampaign(ctx.store, ctx.channelId) : undefined;
    const member = c?.party.find((p) => p.userId === playerId);
    if (c && member) {
      const sheet = await ctx.store.get<Character>(keys.character(c.guildId, member.userId, member.characterId));
      for (const a of sheet?.value.attacks ?? []) options.unshift(choice(`${a.name} attack (${signed(a.toHit)})`, `attack:${a.name}`));
    }
    return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 25);
  },
};
