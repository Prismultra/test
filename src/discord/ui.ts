import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
} from "discord-api-types/v10";
import type { MessageBody } from "./api.js";

export const COLORS = {
  brand: 0x8b5cf6,
  success: 0x22c55e,
  danger: 0xef4444,
  warning: 0xf59e0b,
  info: 0x3b82f6,
  crit: 0xfacc15,
  narration: 0xb45309,
} as const;

export type ActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;

export interface Reply {
  content?: string;
  embeds?: APIEmbed[];
  components?: ActionRow[];
  ephemeral?: boolean;
  /** For component interactions: edit the message the button was on instead of sending a new one. */
  update?: boolean;
  /** Extra messages sent after this one (for content too long for a single message). */
  followups?: Reply[];
  /** Background work to run once this reply and its follow-ups are posted. */
  after?: () => Promise<void>;
  /** Users this message may ping. Nobody is pinged otherwise. */
  mentionUsers?: string[];
}

/** An error shown to the user as-is (ephemeral). */
export class UserError extends Error {}

export const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048, total: 6000 };

export interface EmbedInput {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
  author?: string;
  thumbnail?: string;
  url?: string;
}

/** Builds an embed, trimming every part to Discord's limits. */
export function embed(input: EmbedInput): APIEmbed {
  const e: APIEmbed = { color: input.color ?? COLORS.brand };
  let budget = LIMITS.total;
  const take = (s: string, max: number) => {
    const limit = Math.min(max, budget);
    const t = limit > 0 ? truncate(s, limit) : "";
    budget -= t.length;
    return t;
  };
  if (input.title) e.title = take(input.title, LIMITS.title);
  if (input.author) e.author = { name: take(input.author, LIMITS.title) };
  if (input.footer) e.footer = { text: take(input.footer, LIMITS.footer) };
  if (input.description) e.description = take(input.description, LIMITS.description);
  if (input.url) e.url = input.url;
  if (input.thumbnail) e.thumbnail = { url: input.thumbnail };
  if (input.fields?.length) {
    const fields: APIEmbedField[] = [];
    for (const f of input.fields.slice(0, LIMITS.fields)) {
      if (budget < 20) break;
      const name = take(f.name || "​", LIMITS.fieldName);
      const value = take(f.value || "—", LIMITS.fieldValue);
      fields.push({ name, value, inline: f.inline ?? false });
    }
    e.fields = fields;
  }
  return e;
}

/** Splits long text into chunks no longer than `max`, breaking on paragraphs, lines, then words. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function button(
  customId: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
  emoji?: string,
  disabled = false,
): APIButtonComponentWithCustomId {
  const b: APIButtonComponentWithCustomId = {
    type: ComponentType.Button,
    custom_id: customId.slice(0, 100),
    label: truncate(label, 80),
    style: style as APIButtonComponentWithCustomId["style"],
  };
  if (emoji) b.emoji = { name: emoji };
  if (disabled) b.disabled = true;
  return b;
}

export function row(...components: APIButtonComponentWithCustomId[]): ActionRow {
  return { type: ComponentType.ActionRow, components: components.slice(0, 5) };
}

export const errorReply = (message: string): Reply => ({ content: `❌ ${message}`, ephemeral: true });

export const textReply = (content: string, ephemeral = false): Reply => ({ content, ephemeral });

export function toMessageData(reply: Reply): MessageBody & { flags?: number } {
  const data: MessageBody & { flags?: number } = {
    allowed_mentions: { parse: [], ...(reply.mentionUsers?.length ? { users: reply.mentionUsers.slice(0, 100) } : {}) },
  };
  if (reply.content !== undefined) data.content = truncate(reply.content, 2000);
  if (reply.embeds) data.embeds = reply.embeds.slice(0, 10);
  if (reply.components) data.components = reply.components.slice(0, 5);
  if (reply.ephemeral) data.flags = MessageFlags.Ephemeral;
  return data;
}

export { ButtonStyle };
