import { generateKeyPairSync, sign } from "node:crypto";
import type { APIInteraction, APIInteractionResponse } from "discord-api-types/v10";
import { handleInteraction } from "../src/app.js";
import type { DiscordApi, MessageBody } from "../src/discord/api.js";
import type { Deps } from "../src/discord/context.js";
import type { Rng } from "../src/game/dice.js";
import { MemoryStore } from "../src/store/memory.js";
import type { BetaMessage, DmModel, ModelRequest } from "../src/ai/model.js";

export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const publicHex = der.subarray(der.length - 32).toString("hex");
  return {
    publicHex,
    sign: (timestamp: string, body: string) => sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
  };
}

export class FakeDiscord implements DiscordApi {
  calls: { kind: "edit" | "delete" | "followup"; token: string; body?: MessageBody }[] = [];
  async editOriginal(token: string, body: MessageBody) {
    this.calls.push({ kind: "edit", token, body });
  }
  async deleteOriginal(token: string) {
    this.calls.push({ kind: "delete", token });
  }
  async followup(token: string, body: MessageBody) {
    this.calls.push({ kind: "followup", token, body });
  }
  text(): string {
    return JSON.stringify(this.calls);
  }
}

/** A model that replays scripted responses and records every request. */
export class ScriptedModel implements DmModel {
  requests: ModelRequest[] = [];
  constructor(private script: ((req: ModelRequest) => BetaMessage)[] = []) {}
  push(...steps: ((req: ModelRequest) => BetaMessage)[]) {
    this.script.push(...steps);
  }
  async create(req: ModelRequest): Promise<BetaMessage> {
    // Snapshot: the caller keeps appending to the same array.
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedModel ran out of responses");
    return next(req);
  }
}

let toolId = 0;
export function message(content: unknown[], stop_reason: string): BetaMessage {
  return {
    id: `msg_${toolId++}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as BetaMessage;
}
export const say = (text: string) => () => message([{ type: "text", text }], "end_turn");
export const useTools = (...calls: [string, Record<string, unknown>][]) => () =>
  message(
    calls.map(([name, input]) => ({ type: "tool_use", id: `toolu_${toolId++}`, name, input })),
    "tool_use",
  );

export function makeDeps(opts: { dm?: DmModel; rng?: Rng; store?: Deps["store"] } = {}) {
  const pending: Promise<unknown>[] = [];
  const discord = new FakeDiscord();
  const deps: Deps = {
    config: { discordPublicKey: "00".repeat(32), discordAppId: "app", dmModel: "claude-opus-5-5", dmEffort: "medium" },
    store: opts.store ?? new MemoryStore(),
    discord,
    waitUntil: (p) => void pending.push(p),
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  };
  if (opts.dm) deps.dm = opts.dm;
  if (opts.rng) deps.rng = opts.rng;
  return {
    deps,
    discord,
    /** Waits for all background work (including work it schedules). */
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

export const fixedRng =
  (n: number): Rng =>
  () =>
    n;

export interface User {
  id: string;
  name: string;
}
export const ALEX: User = { id: "111", name: "Alex" };
export const SAM: User = { id: "222", name: "Sam" };

type OptValue = string | number | boolean;
const optType = (v: OptValue) => (typeof v === "string" ? 3 : typeof v === "number" ? 4 : 5);
export const opts = (o: Record<string, OptValue>) => Object.entries(o).map(([name, value]) => ({ name, value, type: optType(value) }));
export const sub = (name: string, o: Record<string, OptValue> = {}) => [{ type: 1, name, options: opts(o) }];

let seq = 0;
function base(user: User, channel = "chan1") {
  return {
    id: `i${seq++}`,
    application_id: "app",
    token: `tok${seq}`,
    version: 1,
    guild_id: "guild1",
    channel_id: channel,
    channel: { id: channel, type: 0 },
    member: {
      user: { id: user.id, username: user.name.toLowerCase(), global_name: user.name, discriminator: "0", avatar: null },
      permissions: "0",
      roles: [],
      nick: null,
      joined_at: "2026-01-01T00:00:00.000Z",
      deaf: false,
      mute: false,
      flags: 0,
    },
    locale: "en-US",
    app_permissions: "0",
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 0,
  };
}

export function command(user: User, name: string, options: unknown[] = [], channel?: string): APIInteraction {
  return { ...base(user, channel), type: 2, data: { id: "c", name, type: 1, options } } as unknown as APIInteraction;
}

export function autocomplete(user: User, name: string, options: unknown[]): APIInteraction {
  return { ...base(user), type: 4, data: { id: "c", name, type: 1, options } } as unknown as APIInteraction;
}

export function click(user: User, customId: string, channel?: string): APIInteraction {
  return {
    ...base(user, channel),
    type: 3,
    message: { id: "m1", channel_id: channel ?? "chan1", content: "", embeds: [], components: [] },
    data: { custom_id: customId, component_type: 2 },
  } as unknown as APIInteraction;
}

export const run = (deps: Deps, i: APIInteraction) => handleInteraction(i, deps) as Promise<APIInteractionResponse & { data?: any }>;
