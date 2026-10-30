import {
  ApplicationCommandOptionType,
  type APIApplicationCommandInteractionDataOption,
  type APIInteraction,
  type APIUser,
} from "discord-api-types/v10";
import type { Config } from "../config.js";
import type { Rng } from "../game/dice.js";
import type { Store } from "../store/store.js";
import type { DiscordApi } from "./api.js";
import { UserError } from "./ui.js";
import type { DmModel } from "../ai/model.js";

export interface Deps {
  config: Config;
  store: Store;
  discord: DiscordApi;
  /** Keeps the serverless function alive until the promise settles. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The AI Dungeon Master, when an Anthropic API key is configured. */
  dm?: DmModel;
  rng?: Rng;
  now?: () => Date;
}

type OptionValue = string | number | boolean;

interface FlatOptions {
  path: string[];
  values: Map<string, OptionValue>;
  focused?: { name: string; value: string };
  resolvedUsers: Record<string, APIUser>;
}

function flatten(interaction: APIInteraction): FlatOptions {
  const out: FlatOptions = { path: [], values: new Map(), resolvedUsers: {} };
  const data = interaction.data as
    | { options?: APIApplicationCommandInteractionDataOption[]; resolved?: { users?: Record<string, APIUser> } }
    | undefined;
  if (!data) return out;
  out.resolvedUsers = data.resolved?.users ?? {};
  const walk = (options: APIApplicationCommandInteractionDataOption[] | undefined) => {
    for (const opt of options ?? []) {
      if (
        opt.type === ApplicationCommandOptionType.Subcommand ||
        opt.type === ApplicationCommandOptionType.SubcommandGroup
      ) {
        out.path.push(opt.name);
        walk(opt.options as APIApplicationCommandInteractionDataOption[] | undefined);
      } else if ("value" in opt) {
        out.values.set(opt.name, opt.value as OptionValue);
        if ("focused" in opt && opt.focused) out.focused = { name: opt.name, value: String(opt.value) };
      }
    }
  };
  walk(data.options);
  return out;
}

/** Convenience accessors over a slash command, autocomplete or component interaction. */
export class Ctx {
  private opts: FlatOptions;

  constructor(
    public readonly interaction: APIInteraction,
    public readonly deps: Deps,
  ) {
    this.opts = flatten(interaction);
  }

  get user(): APIUser {
    const u = this.interaction.member?.user ?? this.interaction.user;
    if (!u) throw new Error("Interaction has no user");
    return u;
  }

  get userId() {
    return this.user.id;
  }

  get userName() {
    return this.interaction.member?.nick ?? this.user.global_name ?? this.user.username;
  }

  /** Guild ID, or "dm" for direct messages. Characters are scoped per guild. */
  get guildId() {
    return this.interaction.guild_id ?? "dm";
  }

  get channelId() {
    const id = this.interaction.channel?.id ?? this.interaction.channel_id;
    if (!id) throw new UserError("This only works in a channel.");
    return id;
  }

  get token() {
    return this.interaction.token;
  }

  get store() {
    return this.deps.store;
  }

  get rng(): Rng | undefined {
    return this.deps.rng;
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get commandName(): string {
    const data = this.interaction.data as { name?: string } | undefined;
    return data?.name ?? "";
  }

  /** e.g. "create" for /char create, or "group sub" for nested subcommands. */
  get subcommand(): string {
    return this.opts.path.join(" ");
  }

  get focused() {
    return this.opts.focused;
  }

  has(name: string) {
    return this.opts.values.has(name);
  }

  string(name: string): string | undefined {
    const v = this.opts.values.get(name);
    return v === undefined ? undefined : String(v);
  }

  requireString(name: string): string {
    const v = this.string(name)?.trim();
    if (!v) throw new UserError(`Missing option \`${name}\`.`);
    return v;
  }

  integer(name: string): number | undefined {
    const v = this.opts.values.get(name);
    return typeof v === "number" ? Math.trunc(v) : undefined;
  }

  requireInteger(name: string): number {
    const v = this.integer(name);
    if (v === undefined) throw new UserError(`Missing option \`${name}\`.`);
    return v;
  }

  boolean(name: string): boolean | undefined {
    const v = this.opts.values.get(name);
    return typeof v === "boolean" ? v : undefined;
  }

  user_(name: string): APIUser | undefined {
    const id = this.string(name);
    return id ? this.opts.resolvedUsers[id] : undefined;
  }
}
