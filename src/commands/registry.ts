import type { APIApplicationCommandOptionChoice } from "discord-api-types/v10";
import type { Ctx } from "../discord/context.js";
import type { Reply } from "../discord/ui.js";

/** A reply that will take a while: Discord gets a "thinking..." response first. */
export interface Deferred {
  deferred: true;
  ephemeral?: boolean;
  work: () => Promise<Reply>;
}

export type HandlerResult = Reply | Deferred;

export const defer = (work: () => Promise<Reply>, ephemeral = false): Deferred => ({ deferred: true, ephemeral, work });

export const isDeferred = (r: HandlerResult): r is Deferred => (r as Deferred).deferred === true;

export type Choice = APIApplicationCommandOptionChoice<string>;

export interface CommandModule {
  names: string[];
  run(ctx: Ctx): Promise<HandlerResult>;
  autocomplete?(ctx: Ctx): Promise<Choice[]>;
}

/** Handles buttons whose custom_id starts with `${prefix}:`. */
export interface ComponentModule {
  prefix: string;
  run(ctx: Ctx, args: string[]): Promise<HandlerResult>;
}

export const choice = (name: string, value = name): Choice => ({
  name: name.length > 100 ? `${name.slice(0, 99)}…` : name,
  value: value.slice(0, 100),
});
