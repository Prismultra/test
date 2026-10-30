import { ButtonStyle } from "discord-api-types/v10";
import type { APIButtonComponentWithCustomId } from "discord-api-types/v10";
import { hpBar } from "../game/character.js";
import { COLORS, UserError, button, chunkText, embed, row, toMessageData, truncate, type ActionRow, type Reply } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";
import { getActive } from "../commands/characters.js";
import { getCombat } from "../commands/combat-store.js";
import { trackerReply } from "../commands/init.js";
import { defer, type CommandModule, type ComponentModule } from "../commands/registry.js";
import { natNote, rollLine } from "../commands/views.js";
import { keys } from "../store/store.js";
import {
  acquireTurn,
  createCampaign,
  editCampaign,
  getCampaign,
  releaseOrTakeQueue,
  releaseTurn,
  requireCampaign,
  newId,
  type Campaign,
  type PendingRoll,
  type QueuedAction,
} from "./campaign.js";
import { askDm, compactIfNeeded, loadParty, resolvePendingRoll, runDmTurn, type DmDeps, type TurnResult } from "./dm.js";
import { LENGTHS, TONES, type TurnTrigger } from "./prompt.js";

/** Extra queued turns one invocation will run before handing the queue to the next /act. */
const MAX_DRAIN = 4;

function dmDeps(ctx: Ctx): DmDeps {
  const model = ctx.deps.dm;
  if (!model) {
    throw new UserError(
      "The AI Dungeon Master isn't enabled for this bot. The bot owner can turn it on by setting `ANTHROPIC_API_KEY`. Everything else (dice, sheets, combat) works without it!",
    );
  }
  const deps: DmDeps = { store: ctx.store, model, now: () => ctx.now() };
  if (ctx.rng) deps.rng = ctx.rng;
  return deps;
}

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

function canManage(ctx: Ctx, campaign: Campaign): boolean {
  if (ctx.userId === campaign.createdBy) return true;
  const perms = ctx.interaction.member?.permissions;
  if (!perms) return false;
  const bits = BigInt(perms);
  return (bits & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
}

function rollButton(r: PendingRoll): APIButtonComponentWithCustomId {
  if (r.result) {
    const style = r.result.success === false ? ButtonStyle.Danger : ButtonStyle.Success;
    return button(`dm:roll:${r.id}`, `${r.characterName}: ${r.label} → ${r.result.total}`, style, "✅", true);
  }
  const mode = r.mode === "advantage" ? " (adv)" : r.mode === "disadvantage" ? " (dis)" : "";
  return button(`dm:roll:${r.id}`, `${r.characterName}: ${r.label}${mode}`, ButtonStyle.Primary, "🎲");
}

function rollRows(rolls: PendingRoll[]): ActionRow[] {
  const rows: ActionRow[] = [];
  for (let i = 0; i < Math.min(rolls.length, 25); i += 5) rows.push(row(...rolls.slice(i, i + 5).map(rollButton)));
  return rows;
}

const quote = (actions: QueuedAction[]) =>
  actions
    .filter((a) => !a.isRollResult)
    .map((a) => `> **${a.characterName}**: ${truncate(a.text.replace(/\n+/g, " "), 300)}`)
    .join("\n");

/** Turns a DM turn into Discord messages: narration (split if long), DM rolls, roll buttons and the tracker. */
async function narrationReply(ctx: Ctx, result: TurnResult, header: string): Promise<Reply> {
  const chunks = chunkText(result.narration, 3900);
  const c = result.campaign;
  const embeds = chunks.map((text, i) =>
    embed({
      description: text,
      color: COLORS.narration,
      ...(i === 0 ? { author: `🐉 ${c.title ?? "Dungeon Master"}` } : {}),
      ...(i === chunks.length - 1 && result.dmRolls.length
        ? { fields: [{ name: "🎲 DM rolls & updates", value: truncate(result.dmRolls.join("\n"), 1024) }] }
        : {}),
      ...(i === chunks.length - 1 && c.scene ? { footer: `📍 ${c.scene}` } : {}),
    }),
  );
  const replies: Reply[] = embeds.map((e) => ({ embeds: [e] }));
  replies[0]!.content = header;
  const last = replies[replies.length - 1]!;
  if (result.requestedRolls.length) {
    last.components = rollRows(result.requestedRolls);
    const users = [...new Set(result.requestedRolls.map((r) => r.userId))];
    last.content = [last === replies[0] ? header : "", `🎲 ${users.map((u) => `<@${u}>`).join(" ")} — click to roll!`]
      .filter(Boolean)
      .join("\n");
    last.mentionUsers = users;
  }
  if (result.combatChanged) {
    const combat = await getCombat(ctx.store, ctx.channelId);
    if (combat) replies.push(trackerReply(combat));
  }
  const [first, ...rest] = replies;
  return { ...first!, ...(rest.length ? { followups: rest } : {}) };
}

/** Posts the replies for a turn run in the background (after the first one), as follow-ups. */
async function postFollowup(ctx: Ctx, reply: Reply) {
  await ctx.deps.discord.followup(ctx.token, toMessageData(reply));
  for (const f of reply.followups ?? []) await ctx.deps.discord.followup(ctx.token, toMessageData(f));
}

/** After a turn: run turns for actions that queued up meanwhile, then fold old transcript into the summary. */
async function drainAndCompact(ctx: Ctx, deps: DmDeps) {
  try {
    for (let i = 0; ; i++) {
      if (i >= MAX_DRAIN) {
        // Leave the rest of the queue for the next /act so this invocation doesn't run too long.
        await releaseTurn(deps.store, ctx.channelId, deps.now());
        break;
      }
      const queued = await releaseOrTakeQueue(deps.store, ctx.channelId, deps.now());
      if (!queued.length) break;
      try {
        const result = await runDmTurn(deps, ctx.channelId, { kind: "actions", actions: queued });
        await postFollowup(ctx, await narrationReply(ctx, result, quote(queued)));
      } catch (err) {
        console.error("queued DM turn failed", err);
        await postFollowup(ctx, { content: `⚠️ The DM lost their train of thought on:\n${quote(queued)}\nPlease try again with \`/act\`.` });
      }
    }
  } catch (err) {
    console.error("draining the DM queue failed", err);
    await releaseTurn(deps.store, ctx.channelId, deps.now());
  }
  await compactIfNeeded(deps, ctx.channelId).catch((err) => console.error("summary failed", err));
}

/** Runs a DM turn as a deferred reply, with queue draining afterwards. The lock must already be held. */
function deferredTurn(ctx: Ctx, deps: DmDeps, trigger: TurnTrigger, header: string) {
  return defer(async () => {
    let result: TurnResult;
    try {
      result = await runDmTurn(deps, ctx.channelId, trigger);
    } catch (err) {
      await releaseTurn(deps.store, ctx.channelId, deps.now());
      throw err;
    }
    const reply = await narrationReply(ctx, result, header);
    reply.after = () => drainAndCompact(ctx, deps);
    return reply;
  });
}

/** Makes sure the user is in the party, joining with their active character if needed. */
async function ensureMember(ctx: Ctx, campaign: Campaign) {
  const member = campaign.party.find((p) => p.userId === ctx.userId);
  if (member) return member;
  const c = await getActive(ctx.store, ctx.guildId, ctx.userId);
  if (!c) throw new UserError("Make a character first with `/char create`, then join with `/dm join`.");
  const { result } = await editCampaign(
    ctx.store,
    ctx.channelId,
    (cur) => {
      const m = { userId: ctx.userId, userName: ctx.userName, characterId: c.id, characterName: c.name };
      cur.party = cur.party.filter((p) => p.userId !== ctx.userId).concat(m);
      return m;
    },
    ctx.now(),
  );
  return result;
}

export const actCommand: CommandModule = {
  names: ["act"],
  async run(ctx) {
    const deps = dmDeps(ctx);
    const text = ctx.requireString("action");
    const campaign = await requireCampaign(ctx.store, ctx.channelId);
    const member = await ensureMember(ctx, campaign);
    const action: QueuedAction = {
      userId: ctx.userId,
      userName: ctx.userName,
      characterName: member.characterName,
      text,
      at: ctx.now().toISOString(),
    };
    const lock = await acquireTurn(ctx.store, ctx.channelId, action, ctx.now());
    if (!lock.acquired) {
      return { content: `${quote([action])}\n-# ⏳ The DM is mid-scene — your action is queued (#${lock.position}).` };
    }
    return deferredTurn(ctx, deps, { kind: "actions", actions: lock.actions }, quote(lock.actions));
  },
};

async function start(ctx: Ctx): Promise<Reply | ReturnType<typeof defer>> {
  const deps = dmDeps(ctx);
  const existing = await getCampaign(ctx.store, ctx.channelId);
  if (existing) {
    throw new UserError(`A campaign${existing.title ? ` (**${existing.title}**)` : ""} is already running here. Use \`/dm end\` first, or start one in another channel.`);
  }
  const campaign = createCampaign({
    channelId: ctx.channelId,
    guildId: ctx.guildId,
    createdBy: ctx.userId,
    premise: ctx.string("premise")?.trim() ?? "",
    tone: ctx.string("tone") ?? "heroic",
    length: ctx.string("length") ?? "short",
    now: ctx.now(),
  });
  const c = await getActive(ctx.store, ctx.guildId, ctx.userId);
  if (c) campaign.party.push({ userId: ctx.userId, userName: ctx.userName, characterId: c.id, characterName: c.name });
  campaign.busySince = ctx.now().toISOString();
  if ((await ctx.store.put(keys.campaign(ctx.channelId), campaign, "create")) === undefined) {
    throw new UserError("A campaign was just started here.");
  }
  const header = [
    "📜 **A new adventure begins!**",
    `-# ${TONES[campaign.tone]?.split(":")[0] ?? campaign.tone} · ${LENGTHS[campaign.length]?.split(" that")[0]?.replace(/^an? /, "") ?? campaign.length}`,
    c ? `Party: **${c.name}**. Others can join with \`/dm join\`.` : "Join with `/dm join` once you have a character (`/char create`).",
    "Play with `/act` · roll when the DM asks · `/dm ask` for out-of-character questions.",
  ].join("\n");
  return deferredTurn(ctx, deps, { kind: "start" }, header);
}

async function join(ctx: Ctx): Promise<Reply> {
  const campaign = await requireCampaign(ctx.store, ctx.channelId);
  const c = await getActive(ctx.store, ctx.guildId, ctx.userId);
  if (!c) throw new UserError("Make a character first with `/char create` (or pick one with `/char use`).");
  const previous = campaign.party.find((p) => p.userId === ctx.userId);
  await editCampaign(
    ctx.store,
    ctx.channelId,
    (cur) => {
      cur.party = cur.party.filter((p) => p.userId !== ctx.userId);
      cur.party.push({ userId: ctx.userId, userName: ctx.userName, characterId: c.id, characterName: c.name });
      cur.transcript.push({
        id: newId(),
        kind: "event",
        text: previous ? `${ctx.userName} now plays ${c.name} instead of ${previous.characterName}.` : `${c.name} (${ctx.userName}) joined the party.`,
        at: ctx.now().toISOString(),
      });
    },
    ctx.now(),
  );
  return {
    content: `🛡️ **${c.name}**, level ${c.level} ${c.species} ${c.className}, joins the party${campaign.title ? ` of **${campaign.title}**` : ""}! Use \`/act\` to jump in.`,
  };
}

async function leave(ctx: Ctx): Promise<Reply> {
  const { result } = await editCampaign(
    ctx.store,
    ctx.channelId,
    (cur) => {
      const m = cur.party.find((p) => p.userId === ctx.userId);
      cur.party = cur.party.filter((p) => p.userId !== ctx.userId);
      if (m) cur.transcript.push({ id: newId(), kind: "event", text: `${m.characterName} left the party.`, at: ctx.now().toISOString() });
      return m;
    },
    ctx.now(),
  );
  if (!result) throw new UserError("You're not in this campaign's party.");
  return { content: `👋 **${result.characterName}** leaves the party.` };
}

async function status(ctx: Ctx): Promise<Reply> {
  const c = await requireCampaign(ctx.store, ctx.channelId);
  const party = await loadParty(ctx.store, c);
  const partyLines = party.map(
    (p) => `**${p.character.name}** (${p.playerName}) — level ${p.character.level} ${p.character.className} · ${p.character.hp}/${p.character.maxHp} HP ${hpBar(p.character.hp, p.character.maxHp, 6)}`,
  );
  const waiting = c.pendingRolls.filter((r) => !r.result).map((r) => `${r.characterName}: ${r.label}`);
  const fields = [
    { name: "Party", value: partyLines.join("\n") || "_Nobody yet — `/dm join`_" },
    { name: "Scene", value: c.scene ?? "—", inline: true },
    { name: "Quest", value: c.quest ?? "—", inline: true },
    { name: "Tone", value: TONES[c.tone]?.split(":")[0] ?? c.tone, inline: true },
  ];
  if (waiting.length) fields.push({ name: "Waiting on rolls", value: waiting.join("\n") });
  if (c.queue.length) fields.push({ name: "Queued actions", value: String(c.queue.length) });
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return {
    embeds: [
      embed({
        title: `📖 ${c.title ?? "Untitled adventure"}`,
        description: c.premise ? `_${truncate(c.premise, 500)}_` : undefined,
        fields,
        color: COLORS.narration,
        footer: `${c.turns} DM turns · ${k(c.usage.inputTokens)} input / ${k(c.usage.outputTokens)} output tokens used`,
      }),
    ],
  };
}

async function end(ctx: Ctx): Promise<Reply> {
  if (!ctx.boolean("confirm")) throw new UserError("Set `confirm` to True to end the campaign.");
  const c = await requireCampaign(ctx.store, ctx.channelId);
  if (!canManage(ctx, c)) throw new UserError("Only the person who started the campaign (or a server manager) can end it.");
  await ctx.store.delete(keys.campaign(ctx.channelId));
  return {
    embeds: [
      embed({
        title: `📕 ${c.title ?? "The adventure"} — The End`,
        description: `After **${c.turns}** turns, the tale is told.${c.summary ? `\n\n${truncate(c.summary, 3000)}` : ""}`,
        color: COLORS.narration,
      }),
    ],
  };
}

export const dmCommand: CommandModule = {
  names: ["dm"],
  async run(ctx) {
    switch (ctx.subcommand) {
      case "start":
        return start(ctx);
      case "join":
        return join(ctx);
      case "leave":
        return leave(ctx);
      case "status":
        return status(ctx);
      case "end":
        return end(ctx);
      case "ask":
      case "recap": {
        const deps = dmDeps(ctx);
        await requireCampaign(ctx.store, ctx.channelId);
        const question =
          ctx.subcommand === "recap"
            ? "Give the players an exciting recap of the story so far in under 150 words, ending with where things stand now."
            : ctx.requireString("question");
        const title = ctx.subcommand === "recap" ? "📖 Previously…" : "💬 Out of character";
        return defer(async () => {
          const answer = await askDm(deps, ctx.channelId, question);
          const reply: Reply = { embeds: [embed({ author: title, description: answer, color: COLORS.info })] };
          if (ctx.subcommand === "ask") reply.content = `> ${truncate(question, 300)}`;
          return reply;
        });
      }
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
};

export const dmButtons: ComponentModule = {
  prefix: "dm",
  async run(ctx, [action, rollId]) {
    if (action !== "roll" || !rollId) throw new UserError("That button doesn't work anymore.");
    const outcome = await resolvePendingRoll(
      { store: ctx.store, now: () => ctx.now(), ...(ctx.rng ? { rng: ctx.rng } : {}) },
      ctx.channelId,
      rollId,
      ctx.userId,
    );
    const r = outcome.roll;
    const lines = outcome.dice.map((d, i) => `${outcome.dice.length > 1 ? (i === 0 ? "**To hit:** " : "**Damage:** ") : ""}\`${d.notation}\` → ${rollLine(d)}`);
    const nat = outcome.dice[0] ? natNote(outcome.dice[0]) : "";
    const verdict = r.result?.success === true ? "✅ **Success!**" : r.result?.success === false ? "❌ **Failure.**" : "";
    const rollMessage: Reply = {
      embeds: [
        embed({
          title: `🎲 ${r.characterName} — ${r.label}`,
          author: ctx.userName,
          description: [r.reason ? `_${r.reason}_` : "", ...lines, nat, verdict].filter(Boolean).join("\n"),
          color: r.result?.success === false ? COLORS.danger : r.result?.success ? COLORS.success : COLORS.brand,
        }),
      ],
    };

    const after = async () => {
      await postFollowup(ctx, rollMessage);
      if (!outcome.batchDone || !ctx.deps.dm) return;
      const deps = dmDeps(ctx);
      const resultsText = outcome.batch.map((b) => b.result?.text ?? "").filter(Boolean);
      const lock = await acquireTurn(
        ctx.store,
        ctx.channelId,
        {
          userId: ctx.userId,
          userName: ctx.userName,
          characterName: r.characterName,
          text: `Roll results: ${resultsText.join(" | ")}`,
          at: ctx.now().toISOString(),
          isRollResult: true,
        },
        ctx.now(),
      );
      if (!lock.acquired) return; // Queued: the running turn will pick the results up.
      // We hold the lock; player actions that queued up meanwhile go into the same turn.
      const others = lock.actions.filter((a) => !a.isRollResult);
      const trigger: TurnTrigger = others.length ? { kind: "actions", actions: lock.actions } : { kind: "rolls", rolls: outcome.batch };
      try {
        const result = await runDmTurn(deps, ctx.channelId, trigger);
        await postFollowup(ctx, await narrationReply(ctx, result, others.length ? quote(others) : ""));
      } catch (err) {
        console.error("DM turn after rolls failed", err);
        await releaseTurn(deps.store, ctx.channelId, deps.now());
        await postFollowup(ctx, { content: "⚠️ The DM fumbled their notes. Continue with `/act` and they'll pick it up." });
        return;
      }
      await drainAndCompact(ctx, deps);
    };

    // Update the clicked message's buttons to show the result; the rest happens in the background.
    return { components: rollRows(outcome.batch), update: true, after };
  },
};
