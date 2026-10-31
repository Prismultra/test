// Electing a human Dungeon Master: when the AI can't run (out of free quota, no
// API credit, or no AI configured) or the party asks for it, the party votes.
import { ButtonStyle } from "discord-api-types/v10";
import { roll, type Rng } from "../game/dice.js";
import type { Store } from "../store/store.js";
import { COLORS, UserError, button, embed, row, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import type { ComponentModule } from "../commands/registry.js";
import { editCampaign, newId, type Campaign, type PartyMember, type QueuedAction } from "./campaign.js";

export interface Elected {
  userId: string;
  userName: string;
}

/** Counts ballots, ignoring voters or candidates who have left the party. */
export function tally(c: Campaign): Map<string, number> {
  const members = new Set(c.party.map((p) => p.userId));
  const counts = new Map<string, number>();
  for (const [voter, candidate] of Object.entries(c.vote?.ballots ?? {})) {
    if (members.has(voter) && members.has(candidate)) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  return counts;
}

/**
 * Decides the vote if it can be decided: a majority of the party, or (once
 * everyone has voted, or someone closes it) the most votes, with ties settled
 * by a d20 roll-off.
 */
export function decide(c: Campaign, opts: { close?: boolean; rng?: Rng } = {}): { winner: PartyMember; note?: string } | undefined {
  const n = c.party.length;
  if (n === 0) return undefined;
  const counts = tally(c);
  const cast = [...counts.values()].reduce((a, b) => a + b, 0);
  for (const [id, votes] of counts) {
    if (votes > n / 2) return { winner: c.party.find((p) => p.userId === id)! };
  }
  if (!opts.close && cast < n) return undefined;
  if (cast === 0) return undefined;
  const best = Math.max(...counts.values());
  let tied = c.party.filter((p) => counts.get(p.userId) === best);
  if (tied.length === 1) return { winner: tied[0]! };
  // Roll-off: everyone tied rolls a d20; reroll among those who tie again.
  const lines: string[] = [];
  for (let round = 0; tied.length > 1 && round < 10; round++) {
    const rolls = tied.map((p) => ({ p, r: roll("1d20", opts.rng ? { rng: opts.rng } : {}).total }));
    lines.push(rolls.map(({ p, r }) => `${p.userName} 🎲${r}`).join(" · "));
    const top = Math.max(...rolls.map((x) => x.r));
    tied = rolls.filter((x) => x.r === top).map((x) => x.p);
  }
  return { winner: tied[0]!, note: `Tie! Roll-off: ${lines.join(" → ")}` };
}

function makeDm(c: Campaign, winner: Elected, now: Date) {
  c.mode = "human";
  c.humanDm = { userId: winner.userId, userName: winner.userName, since: now.toISOString() };
  delete c.vote;
  c.transcript.push({ id: newId(), kind: "event", text: `${winner.userName} became the Dungeon Master.`, at: now.toISOString() });
}

export function voteReply(c: Campaign, note?: string): Reply {
  const counts = tally(c);
  const lines = c.party.map((p) => {
    const n = counts.get(p.userId) ?? 0;
    return `**${p.userName}** (${p.characterName}) — ${n} vote${n === 1 ? "" : "s"}`;
  });
  const voted = Object.keys(c.vote?.ballots ?? {}).filter((v) => c.party.some((p) => p.userId === v)).length;
  const id = c.vote?.id ?? "x";
  const candidates = c.party.slice(0, 20).map((p) => button(`vote:${id}:${p.userId}`, `${p.userName}`, ButtonStyle.Primary, "👑"));
  const rows = [];
  for (let i = 0; i < candidates.length; i += 5) rows.push(row(...candidates.slice(i, i + 5)));
  rows.push(row(button(`vote:${id}:close`, "Close vote now", ButtonStyle.Secondary, "⏹️")));
  return {
    content: note ?? "",
    embeds: [
      embed({
        title: "🗳️ Who should be the Dungeon Master?",
        description: `${c.vote?.reason ?? ""}\n\n${lines.join("\n") || "_Nobody's in the party yet — `/dm join` first._"}`,
        color: COLORS.warning,
        footer: `${voted}/${c.party.length} voted · majority wins · ties are settled with a d20 roll-off`,
      }),
    ],
    components: rows,
    mentionUsers: c.party.map((p) => p.userId),
  };
}

export function electedReply(c: Campaign, note?: string): Reply {
  const dm = c.humanDm!;
  return {
    content: `👑 <@${dm.userId}> is now the Dungeon Master!${note ? `\n-# ${note}` : ""}`,
    embeds: [
      embed({
        title: `🧙 ${dm.userName} runs the game now`,
        description: [
          "**DM tools**",
          "• `/group-status` — the whole picture (only you can see it): story, notes, everyone's sheets, combat with monster HP, pending rolls",
          "• `/narrate` — tell the story; it's saved so the AI can pick up later",
          "• `/request-roll` — make a player roll for their fate: they get a 🎲 button and their sheet's bonuses apply",
          "• `/party` — you control HP, levels, XP, items, coins and conditions (players can't change those themselves)",
          "• `/init` and `/monster` work as usual for fights",
          "• `/dm ai` — hand the seat back to the AI when it's available again",
          "",
          "**Players** keep using `/act`, and roll with `/check`, `/save` and `/attack`.",
        ].join("\n"),
        color: COLORS.success,
      }),
    ],
    mentionUsers: [dm.userId],
  };
}

/**
 * Starts a vote for a human DM (or, with one party member or none, makes the
 * person who asked the DM straight away). Actions the AI didn't get to are
 * saved to the story so the new DM sees them.
 */
export async function openVote(
  store: Store,
  channelId: string,
  opts: { reason: string; requestedBy?: Elected; pendingActions?: QueuedAction[]; now: Date; header?: string },
): Promise<Reply> {
  const { result } = await editCampaign(
    store,
    channelId,
    (c): { kind: "vote" | "elected" | "already"; campaign: Campaign } => {
      // Save actions the AI never got to (including anything still queued) for the new DM.
      for (const a of [...(opts.pendingActions ?? []), ...c.queue]) {
        if (!a.wake) c.transcript.push({ id: newId(), kind: "player", author: `${a.userName} as ${a.characterName}`, text: a.text, at: a.at });
      }
      c.queue = [];
      if (c.vote) return { kind: "already", campaign: c };
      if (c.party.length <= 1) {
        const solo = c.party[0] ?? opts.requestedBy;
        if (!solo) throw new UserError("Nobody's in the party yet. Join with `/dm join`, then try again.");
        makeDm(c, { userId: solo.userId, userName: solo.userName }, opts.now);
        return { kind: "elected", campaign: c };
      }
      c.vote = { id: newId(), reason: opts.reason, startedAt: opts.now.toISOString(), ballots: {} };
      return { kind: "vote", campaign: c };
    },
    opts.now,
  );
  const header = opts.header ? `${opts.header}\n` : "";
  if (result.kind === "elected") return electedReply(result.campaign, header.trim() || undefined);
  const reply = voteReply(result.campaign, `${header}🗳️ Vote for a Dungeon Master!`);
  if (result.kind === "already") reply.content = `${header}A vote is already open — here it is again.`;
  return reply;
}

export const voteButtons: ComponentModule = {
  prefix: "vote",
  async run(ctx: Ctx, [voteId, choice]) {
    const now = ctx.now();
    const { result } = await editCampaign(
      ctx.store,
      ctx.channelId,
      (c): { done?: { note?: string }; campaign: Campaign } => {
        if (!c.vote || c.vote.id !== voteId) throw new UserError("That vote is over.");
        if (!c.party.some((p) => p.userId === ctx.userId)) throw new UserError("Only party members can vote. Join with `/dm join`.");
        if (choice === "close") {
          const decided = decide(c, { close: true, ...(ctx.rng ? { rng: ctx.rng } : {}) });
          if (!decided) throw new UserError("Nobody has voted yet.");
          makeDm(c, decided.winner, now);
          return { done: decided.note ? { note: decided.note } : {}, campaign: c };
        }
        if (!c.party.some((p) => p.userId === choice)) throw new UserError("That player left the party.");
        c.vote.ballots[ctx.userId] = choice!;
        const decided = decide(c, ctx.rng ? { rng: ctx.rng } : {});
        if (decided) {
          makeDm(c, decided.winner, now);
          return { done: decided.note ? { note: decided.note } : {}, campaign: c };
        }
        return { campaign: c };
      },
      now,
    );
    if (result.done) {
      const dm = result.campaign.humanDm!;
      return {
        ...electedReply(result.campaign, result.done.note),
        components: [],
        update: true,
        // Edits don't ping, so announce the new DM in a fresh message.
        followups: [{ content: `👑 <@${dm.userId}>, the party chose you as Dungeon Master! Start with \`/group-status\`.`, mentionUsers: [dm.userId] }],
      };
    }
    return { ...voteReply(result.campaign), update: true };
  },
};
