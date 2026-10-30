import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIInteraction,
  type APIInteractionResponse,
  type APIMessageComponentInteraction,
} from "discord-api-types/v10";
import { ConflictError } from "./store/store.js";
import { Ctx, type Deps } from "./discord/context.js";
import { verifyDiscordSignature } from "./discord/verify.js";
import { UserError, errorReply, toMessageData, type Reply } from "./discord/ui.js";
import { isDeferred, type CommandModule, type ComponentModule, type HandlerResult } from "./commands/registry.js";
import { rollCommand } from "./commands/roll.js";
import { charCommand } from "./commands/char.js";
import { attackCommand, checkCommand, deathSaveCommand, saveCommand } from "./commands/checks.js";
import { hpCommand, restCommand } from "./commands/hp.js";
import { conditionCommand, itemCommand, monsterCommand, monsterPages } from "./commands/lookup.js";
import { spellCommand } from "./commands/spells.js";
import { inventoryCommand } from "./commands/inventory.js";
import { initButtons, initCommand } from "./commands/init.js";
import { helpCommand } from "./commands/help.js";
import { actCommand, dmButtons, dmCommand } from "./ai/commands.js";

const COMMAND_MODULES: CommandModule[] = [
  rollCommand,
  charCommand,
  checkCommand,
  saveCommand,
  attackCommand,
  deathSaveCommand,
  hpCommand,
  restCommand,
  spellCommand,
  monsterCommand,
  conditionCommand,
  itemCommand,
  inventoryCommand,
  initCommand,
  actCommand,
  dmCommand,
  helpCommand,
];

const COMPONENT_MODULES: ComponentModule[] = [initButtons, monsterPages, dmButtons];

const commands = new Map(COMMAND_MODULES.flatMap((m) => m.names.map((n) => [n, m] as const)));
const components = new Map(COMPONENT_MODULES.map((m) => [m.prefix, m]));

/** Discord needs a response within 3 seconds; anything slower than this gets deferred. */
export const SOFT_DEADLINE_MS = 2200;

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "GET") {
    return new Response("Tavernkeep is running. Set this URL as your Discord Interactions Endpoint URL.", { status: 200 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();
  const ok = verifyDiscordSignature(
    raw,
    req.headers.get("x-signature-ed25519"),
    req.headers.get("x-signature-timestamp"),
    deps.config.discordPublicKey,
  );
  if (!ok) return new Response("invalid request signature", { status: 401 });
  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(raw) as APIInteraction;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  return Response.json(await handleInteraction(interaction, deps));
}

export async function handleInteraction(interaction: APIInteraction, deps: Deps): Promise<APIInteractionResponse> {
  switch (interaction.type) {
    case InteractionType.Ping:
      return { type: InteractionResponseType.Pong };

    case InteractionType.ApplicationCommand: {
      const ctx = new Ctx(interaction, deps);
      const mod = commands.get(ctx.commandName);
      if (!mod) return respond(errorReply("Unknown command. Try re-registering commands."), "command");
      return run(ctx, () => mod.run(ctx), "command", ctx.boolean("private") ?? false);
    }

    case InteractionType.ApplicationCommandAutocomplete: {
      const ctx = new Ctx(interaction, deps);
      const mod = commands.get(ctx.commandName);
      let choices: Awaited<ReturnType<NonNullable<CommandModule["autocomplete"]>>> = [];
      try {
        choices = (await mod?.autocomplete?.(ctx)) ?? [];
      } catch (err) {
        if (!(err instanceof UserError)) console.error("autocomplete failed", err);
      }
      return { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices: choices.slice(0, 25) } };
    }

    case InteractionType.MessageComponent: {
      const ctx = new Ctx(interaction, deps);
      const [prefix = "", ...args] = (interaction as APIMessageComponentInteraction).data.custom_id.split(":");
      const mod = components.get(prefix);
      if (!mod) return respond(errorReply("That button doesn't work anymore."), "component");
      return run(ctx, () => mod.run(ctx, args), "component", false);
    }

    default:
      return respond(errorReply("Unsupported interaction."), "command");
  }
}

type Kind = "command" | "component";

const TIMEOUT = Symbol("timeout");

async function run(ctx: Ctx, fn: () => Promise<HandlerResult>, kind: Kind, ephemeralHint: boolean): Promise<APIInteractionResponse> {
  const pending: Promise<HandlerResult> = fn().catch((err: unknown) => toErrorReply(err));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    pending,
    new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), SOFT_DEADLINE_MS);
    }),
  ]);
  clearTimeout(timer);

  if (raced !== TIMEOUT && !isDeferred(raced)) {
    if (raced.followups?.length || raced.after) {
      const { followups = [], after } = raced;
      ctx.deps.waitUntil(
        (async () => {
          await sendFollowups(ctx, followups);
          await after?.();
        })().catch((err) => console.error("background work failed", err)),
      );
    }
    return respond(raced, kind);
  }

  // Too slow (or explicitly deferred): acknowledge now, deliver the real reply when it's ready.
  const ephemeral = raced !== TIMEOUT && isDeferred(raced) ? (raced.ephemeral ?? false) : ephemeralHint;
  ctx.deps.waitUntil(
    (async () => {
      let reply: Reply;
      try {
        const result = raced === TIMEOUT ? await pending : raced;
        reply = isDeferred(result) ? await result.work() : result;
      } catch (err) {
        reply = toErrorReply(err);
      }
      await deliver(ctx, reply, kind, ephemeral);
    })().catch((err) => console.error("failed to deliver deferred reply", err)),
  );
  if (kind === "component") return { type: InteractionResponseType.DeferredMessageUpdate };
  return {
    type: InteractionResponseType.DeferredChannelMessageWithSource,
    ...(ephemeral ? { data: { flags: MessageFlags.Ephemeral } } : {}),
  };
}

function respond(reply: Reply, kind: Kind): APIInteractionResponse {
  const data = toMessageData(reply);
  if (kind === "component" && reply.update) {
    delete data.flags;
    return { type: InteractionResponseType.UpdateMessage, data };
  }
  return { type: InteractionResponseType.ChannelMessageWithSource, data };
}

async function deliver(ctx: Ctx, reply: Reply, kind: Kind, deferredEphemeral: boolean) {
  const { discord } = ctx.deps;
  const data = toMessageData(reply);
  try {
    if (kind === "component") {
      if (reply.update) {
        delete data.flags;
        await discord.editOriginal(ctx.token, data);
      } else {
        await discord.followup(ctx.token, data);
      }
    } else if (reply.ephemeral && !deferredEphemeral) {
      // The "thinking..." message was public; replace it with a private one.
      await discord.deleteOriginal(ctx.token).catch(() => undefined);
      await discord.followup(ctx.token, data);
    } else {
      delete data.flags;
      await discord.editOriginal(ctx.token, data);
    }
    if (reply.followups?.length) await sendFollowups(ctx, reply.followups);
  } finally {
    // Cleanup such as releasing locks must run even if Discord rejected the message.
    await reply.after?.();
  }
}

async function sendFollowups(ctx: Ctx, followups: Reply[]) {
  for (const f of followups) {
    await ctx.deps.discord.followup(ctx.token, toMessageData(f)).catch((err) => console.error("follow-up failed", err));
  }
}

function toErrorReply(err: unknown): Reply {
  if (err instanceof UserError) return errorReply(err.message);
  if (err instanceof ConflictError) return errorReply("Lots happening at once — please try that again.");
  console.error("command failed", err);
  return errorReply("Something went wrong on my end. Please try again.");
}
