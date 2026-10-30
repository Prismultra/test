import { randomUUID } from "node:crypto";
import type { RollMode } from "../game/dice.js";
import { keys, update, type Store } from "../store/store.js";
import { UserError } from "../discord/ui.js";

export interface PartyMember {
  userId: string;
  userName: string;
  characterId: string;
  characterName: string;
}

export interface TranscriptEntry {
  id: string;
  kind: "player" | "dm" | "roll" | "event";
  author?: string;
  text: string;
  at: string;
}

export type RollKind = "skill" | "ability" | "save" | "attack";

export interface PendingRoll {
  id: string;
  /** Rolls requested in the same DM turn share a batch; the story continues once all are rolled. */
  batch: string;
  userId: string;
  characterId: string;
  characterName: string;
  kind: RollKind;
  /** Skill key, ability key or attack name. */
  key: string;
  label: string;
  dc?: number;
  mode: RollMode;
  reason: string;
  result?: { total: number; text: string; success?: boolean };
}

export interface QueuedAction {
  userId: string;
  userName: string;
  characterName: string;
  text: string;
  at: string;
  /** Roll results that arrived while another turn was running. */
  isRollResult?: boolean;
}

export interface Campaign {
  channelId: string;
  guildId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  premise: string;
  tone: string;
  length: string;
  title?: string;
  scene?: string;
  quest?: string;
  party: PartyMember[];
  summary: string;
  notes: string[];
  transcript: TranscriptEntry[];
  turns: number;
  /** Set while a DM turn is being generated; new actions queue up behind it. */
  busySince?: string;
  queue: QueuedAction[];
  pendingRolls: PendingRoll[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; calls: number };
}

/** A lock older than this is assumed to belong to a crashed turn. */
export const LOCK_TIMEOUT_MS = 4 * 60 * 1000;
export const MAX_NOTES = 50;
export const MAX_QUEUE = 20;

export const newId = () => randomUUID().replace(/-/g, "").slice(0, 12);

export function createCampaign(opts: {
  channelId: string;
  guildId: string;
  createdBy: string;
  premise: string;
  tone: string;
  length: string;
  now: Date;
}): Campaign {
  const at = opts.now.toISOString();
  return {
    channelId: opts.channelId,
    guildId: opts.guildId,
    createdBy: opts.createdBy,
    createdAt: at,
    updatedAt: at,
    premise: opts.premise,
    tone: opts.tone,
    length: opts.length,
    party: [],
    summary: "",
    notes: [],
    transcript: [],
    turns: 0,
    queue: [],
    pendingRolls: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 },
  };
}

export async function getCampaign(store: Store, channelId: string): Promise<Campaign | undefined> {
  return (await store.get<Campaign>(keys.campaign(channelId)))?.value;
}

export async function requireCampaign(store: Store, channelId: string): Promise<Campaign> {
  const c = await getCampaign(store, channelId);
  if (!c) throw new UserError("There's no campaign in this channel. Start one with `/dm start`.");
  return c;
}

export async function editCampaign<R>(
  store: Store,
  channelId: string,
  fn: (c: Campaign) => R,
  now = new Date(),
): Promise<{ campaign: Campaign; result: R }> {
  const out = await update<Campaign, { campaign: Campaign; result: R }>(store, keys.campaign(channelId), (cur) => {
    if (!cur) throw new UserError("There's no campaign in this channel. Start one with `/dm start`.");
    const result = fn(cur);
    cur.updatedAt = now.toISOString();
    return { value: cur, result: { campaign: cur, result } };
  });
  return out!;
}

const lockHeld = (c: Campaign, now: Date) =>
  c.busySince !== undefined && now.getTime() - new Date(c.busySince).getTime() < LOCK_TIMEOUT_MS;

export type AcquireResult = { acquired: true; actions: QueuedAction[] } | { acquired: false; position: number };

/**
 * Takes the campaign's turn lock. If another turn is running, the action is
 * queued instead. On success, returns any queued actions plus the new one.
 */
export async function acquireTurn(store: Store, channelId: string, action: QueuedAction | undefined, now: Date) {
  const { result } = await editCampaign<AcquireResult>(
    store,
    channelId,
    (c) => {
      if (lockHeld(c, now)) {
        if (!action) return { acquired: false, position: c.queue.length };
        if (c.queue.length >= MAX_QUEUE) throw new UserError("The DM has a lot to catch up on — wait a moment and try again.");
        c.queue.push(action);
        return { acquired: false, position: c.queue.length };
      }
      c.busySince = now.toISOString();
      const actions = [...c.queue, ...(action ? [action] : [])];
      c.queue = [];
      return { acquired: true, actions };
    },
    now,
  );
  return result;
}

/** Releases the lock, unless actions queued up meanwhile; then returns them and keeps the lock. */
export async function releaseOrTakeQueue(store: Store, channelId: string, now: Date): Promise<QueuedAction[]> {
  const { result } = await editCampaign(
    store,
    channelId,
    (c) => {
      if (c.queue.length) {
        const q = c.queue;
        c.queue = [];
        c.busySince = now.toISOString();
        return q;
      }
      delete c.busySince;
      return [];
    },
    now,
  );
  return result;
}

export async function releaseTurn(store: Store, channelId: string, now: Date) {
  await editCampaign(store, channelId, (c) => void delete c.busySince, now).catch(() => undefined);
}
