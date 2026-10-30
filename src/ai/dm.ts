import { mod, profBonus, rollCheck, rollSave, type Character } from "../game/character.js";
import { applyMode, critical, evaluate, parse, totalsByLabel, type Rng, type RollResult } from "../game/dice.js";
import { parseAbility, parseSkill, signed } from "../game/rules.js";
import { keys, type Store } from "../store/store.js";
import { UserError } from "../discord/ui.js";
import { getCombat } from "../commands/combat-store.js";
import { weaponAttack } from "../commands/char.js";
import {
  editCampaign,
  getCampaign,
  newId,
  requireCampaign,
  type Campaign,
  type PendingRoll,
  type TranscriptEntry,
} from "./campaign.js";
import type { BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaToolResultBlockParam, DmModel } from "./model.js";
import { ASK_SYSTEM, SUMMARY_SYSTEM, SYSTEM_PROMPT, buildTurnMessage, transcriptLine, type PartySheet, type TurnTrigger } from "./prompt.js";
import { DM_TOOLS, ToolError, runTool, type ToolContext } from "./tools.js";

export interface DmDeps {
  store: Store;
  model: DmModel;
  now: () => Date;
  rng?: Rng;
}

export interface TurnResult {
  narration: string;
  dmRolls: string[];
  requestedRolls: PendingRoll[];
  combatChanged: boolean;
  refused: boolean;
  campaign: Campaign;
}

/** Tool-use round trips allowed in one DM turn (a busy combat round can need several). */
export const MAX_STEPS = 14;
/** Transcript entries kept verbatim; older ones get folded into the summary. */
export const KEEP_TRANSCRIPT = 14;
export const COMPACT_AT = 34;

const SYSTEM: BetaTextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];

export async function loadParty(store: Store, campaign: Campaign): Promise<PartySheet[]> {
  const sheets = await Promise.all(
    campaign.party.map(async (p) => {
      const c = await store.get<Character>(keys.character(campaign.guildId, p.userId, p.characterId));
      return c ? { playerName: p.userName, character: c.value } : undefined;
    }),
  );
  return sheets.filter((s): s is PartySheet => Boolean(s));
}

const textOf = (m: BetaMessage) =>
  m.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

function addUsage(c: Campaign, m: BetaMessage) {
  c.usage.calls++;
  c.usage.inputTokens += m.usage.input_tokens + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0);
  c.usage.outputTokens += m.usage.output_tokens;
  c.usage.cacheReadTokens += m.usage.cache_read_input_tokens ?? 0;
}

function triggerEntries(trigger: TurnTrigger, at: string): TranscriptEntry[] {
  if (trigger.kind === "start") return [{ id: newId(), kind: "event", text: "The adventure began.", at }];
  if (trigger.kind === "rolls") {
    return trigger.rolls.map((r) => ({ id: newId(), kind: "roll", text: r.result?.text ?? `${r.characterName}: ${r.label} (not rolled)`, at }));
  }
  return trigger.actions.map((a): TranscriptEntry =>
    a.isRollResult
      ? { id: newId(), kind: "roll", text: a.text, at }
      : { id: newId(), kind: "player", author: `${a.userName} as ${a.characterName}`, text: a.text, at },
  );
}

/** Runs one Dungeon Master turn: the model narrates and uses tools, then the campaign is saved. */
export async function runDmTurn(deps: DmDeps, channelId: string, trigger: TurnTrigger): Promise<TurnResult> {
  const now = deps.now();
  const campaign = await requireCampaign(deps.store, channelId);
  const party = await loadParty(deps.store, campaign);
  const combat = await getCombat(deps.store, channelId);
  const working = structuredClone(campaign);
  const ctx: ToolContext = {
    store: deps.store,
    campaign: working,
    party,
    batch: newId(),
    now,
    dmRolls: [],
    requestedRolls: [],
    combatChanged: false,
  };
  if (deps.rng) ctx.rng = deps.rng;

  // Each turn is a fresh conversation built from the saved state, so nothing from
  // earlier turns (including thinking blocks) is replayed. Within the turn the
  // history is append-only.
  const messages: BetaMessageParam[] = [{ role: "user", content: buildTurnMessage({ campaign, party, combat, trigger }) }];
  const texts: string[] = [];
  let refused = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await deps.model.create({ system: SYSTEM, tools: DM_TOOLS, messages });
    addUsage(working, res);
    if (res.stop_reason === "refusal") {
      refused = true;
      break;
    }
    const text = textOf(res);
    if (text) texts.push(text);
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (res.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: res.content });
    const results: BetaToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      try {
        const out = await runTool(ctx, block.name, (block.input ?? {}) as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      } catch (err) {
        if (!(err instanceof ToolError || err instanceof UserError)) console.error(`DM tool ${block.name} failed`, err);
        const message = err instanceof ToolError || err instanceof UserError ? err.message : "That didn't work; carry on without it.";
        results.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  let narration = texts.join("\n\n").trim();
  if (refused) {
    narration = "*The Dungeon Master pauses and shakes their head.* That's not a scene I can run. Try a different approach!";
  } else if (!narration) {
    narration = "*The Dungeon Master considers the situation…* What do you do?";
  }

  const at = now.toISOString();
  const entries = [...triggerEntries(trigger, at), { id: newId(), kind: "dm" as const, text: narration, at }];
  const { campaign: saved } = await editCampaign(
    deps.store,
    channelId,
    (c) => {
      c.transcript.push(...entries);
      c.turns++;
      for (const k of ["title", "scene", "quest"] as const) {
        const v = working[k];
        if (v !== undefined) c[k] = v;
      }
      c.notes = working.notes;
      // Roll requests from earlier turns expire; the DM re-asks if they still matter.
      c.pendingRolls = ctx.requestedRolls;
      c.usage = working.usage;
    },
    now,
  );

  return { narration, dmRolls: ctx.dmRolls, requestedRolls: ctx.requestedRolls, combatChanged: ctx.combatChanged, refused, campaign: saved };
}

export interface RollOutcome {
  roll: PendingRoll;
  dice: RollResult[];
  /** True when every roll in this roll's batch has a result. */
  batchDone: boolean;
  batch: PendingRoll[];
}

/** Rolls a requested check for the player who clicked its button and records the result. */
export async function resolvePendingRoll(
  deps: { store: Store; now: () => Date; rng?: Rng },
  channelId: string,
  rollId: string,
  clickerId: string,
): Promise<RollOutcome> {
  const campaign = await requireCampaign(deps.store, channelId);
  const pending = campaign.pendingRolls.find((r) => r.id === rollId);
  if (!pending) throw new UserError("That roll isn't needed anymore — the story has moved on.");
  if (pending.result) throw new UserError(`${pending.characterName} already rolled that.`);
  if (clickerId !== pending.userId && clickerId !== campaign.createdBy) {
    throw new UserError(`This roll is for **${pending.characterName}**.`);
  }
  const charEntry = await deps.store.get<Character>(keys.character(campaign.guildId, pending.userId, pending.characterId));
  if (!charEntry) throw new UserError(`${pending.characterName}'s sheet is gone.`);
  const c = charEntry.value;
  const { result, dice } = rollFor(c, pending, deps.rng);

  const { result: outcome } = await editCampaign(
    deps.store,
    channelId,
    (cur) => {
      const r = cur.pendingRolls.find((x) => x.id === rollId);
      if (!r) throw new UserError("That roll isn't needed anymore — the story has moved on.");
      if (r.result) throw new UserError(`${r.characterName} already rolled that.`);
      r.result = result;
      const batch = cur.pendingRolls.filter((x) => x.batch === r.batch);
      return { roll: r, dice, batch, batchDone: batch.every((x) => x.result) };
    },
    deps.now(),
  );
  return outcome;
}

function rollFor(c: Character, p: PendingRoll, rng?: Rng): { result: NonNullable<PendingRoll["result"]>; dice: RollResult[] } {
  const opts = { mode: p.mode, ...(rng ? { rng } : {}) };
  const why = p.reason ? ` (${p.reason})` : "";
  const vs = (total: number) => (p.dc === undefined ? "" : total >= p.dc ? ` vs DC ${p.dc} → success` : ` vs DC ${p.dc} → failure`);
  const modeNote = p.mode === "normal" ? "" : ` with ${p.mode}`;

  if (p.kind === "skill" || p.kind === "ability" || p.kind === "save") {
    let r: RollResult;
    if (p.kind === "save") {
      r = rollSave(c, parseAbility(p.key) ?? "dex", opts).roll;
    } else {
      const skill = p.kind === "skill" ? parseSkill(p.key) : undefined;
      r = rollCheck(c, skill ? { skill } : { ability: parseAbility(p.key) ?? "str" }, opts).roll;
    }
    const nat = r.natural !== undefined ? `natural ${r.natural}` : r.notation;
    const result: NonNullable<PendingRoll["result"]> = {
      total: r.total,
      text: `${c.name} — ${p.label}${why}${modeNote}: ${r.total} (${nat})${vs(r.total)}`,
    };
    if (p.dc !== undefined) result.success = r.total >= p.dc;
    return { result, dice: [r] };
  }

  // Attack: roll to hit, then damage (doubled dice on a natural 20).
  const atk = attackFor(c, p.key);
  const hit = evaluate(applyMode(parse(`1d20${atk.toHit >= 0 ? "+" : ""}${atk.toHit}`), p.mode), rng);
  const crit = hit.natural === 20;
  const lands = hit.natural !== 1 && (crit || p.dc === undefined || hit.total >= p.dc);
  const dmgTerms = parse(atk.damage);
  const dmg = evaluate(crit ? critical(dmgTerms) : dmgTerms, rng);
  const types = Object.entries(totalsByLabel(dmg))
    .filter(([, v]) => v)
    .map(([k, v]) => `${v}${k ? ` ${k}` : ""}`)
    .join(" + ");
  const verdict =
    p.dc === undefined
      ? `damage if it hits: ${dmg.total} (${types})`
      : lands
        ? `${crit ? "CRITICAL HIT" : "hit"} for ${dmg.total} damage (${types})`
        : `${hit.natural === 1 ? "natural 1, " : ""}miss`;
  const result: NonNullable<PendingRoll["result"]> = {
    total: hit.total,
    text: `${c.name} — ${atk.name} attack${why}${modeNote}: ${hit.total} to hit (natural ${hit.natural})${p.dc !== undefined ? ` vs AC ${p.dc}` : ""} → ${verdict}`,
  };
  if (p.dc !== undefined) result.success = lands;
  return { result, dice: lands || p.dc === undefined ? [hit, dmg] : [hit] };
}

function attackFor(c: Character, key: string): { name: string; toHit: number; damage: string } {
  if (key.startsWith("weapon:")) {
    const w = weaponAttack(c, key.slice("weapon:".length));
    if (w) return w;
  }
  const own = c.attacks.find((a) => a.name === key);
  if (own) return own;
  const best = Math.max(mod(c, "str"), mod(c, "dex"));
  const name = key.startsWith("improvised:") ? key.slice("improvised:".length) : key;
  return { name, toHit: best + profBonus(c), damage: `1d6${best ? signed(best) : ""}` };
}

/** Folds the oldest transcript entries into the running summary once the transcript gets long. */
export async function compactIfNeeded(deps: DmDeps, channelId: string): Promise<boolean> {
  const c = await getCampaign(deps.store, channelId);
  if (!c || c.transcript.length < COMPACT_AT) return false;
  const old = c.transcript.slice(0, c.transcript.length - KEEP_TRANSCRIPT);
  const res = await deps.model.create({
    system: [{ type: "text", text: SUMMARY_SYSTEM }],
    messages: [
      {
        role: "user",
        content: `<earlier_summary>\n${c.summary || "(none yet)"}\n</earlier_summary>\n\n<transcript_excerpt>\n${old.map(transcriptLine).join("\n\n")}\n</transcript_excerpt>`,
      },
    ],
    maxTokens: 4000,
    effort: "low",
  });
  const summary = res.stop_reason === "refusal" ? "" : textOf(res);
  if (!summary) return false;
  const ids = new Set(old.map((e) => e.id));
  await editCampaign(
    deps.store,
    channelId,
    (cur) => {
      addUsage(cur, res);
      if (!cur.transcript.slice(0, old.length).every((e) => ids.has(e.id))) return;
      cur.transcript = cur.transcript.filter((e) => !ids.has(e.id));
      cur.summary = summary;
    },
    deps.now(),
  );
  return true;
}

/** An out-of-character answer, or a recap, without advancing the story. */
export async function askDm(deps: DmDeps, channelId: string, question: string): Promise<string> {
  const campaign = await requireCampaign(deps.store, channelId);
  const party = await loadParty(deps.store, campaign);
  const combat = await getCombat(deps.store, channelId);
  const context = buildTurnMessage({ campaign, party, combat, trigger: { kind: "actions", actions: [] } }).replace(
    /<new>[\s\S]*<\/new>/,
    "",
  );
  const res = await deps.model.create({
    system: [{ type: "text", text: ASK_SYSTEM }],
    messages: [{ role: "user", content: `${context.trim()}\n\n<question>\n${question}\n</question>` }],
    maxTokens: 4000,
    effort: "low",
  });
  await editCampaign(deps.store, channelId, (c) => addUsage(c, res), deps.now()).catch(() => undefined);
  if (res.stop_reason === "refusal") return "I can't help with that one — try asking another way.";
  return textOf(res) || "Hmm, I'm not sure. Try asking another way.";
}
