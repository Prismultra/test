// In a campaign, the Dungeon Master controls levels, HP, loot and conditions.
// Players keep their dice and cosmetic fields; edits to the rest are locked.
import { getCampaign, isHumanRun, type Campaign } from "../ai/campaign.js";
import { UserError } from "../discord/ui.js";
import type { Ctx } from "../discord/context.js";

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

/** The campaign's creator, or someone who can manage the server. */
export function canManage(ctx: Ctx, campaign: Campaign): boolean {
  if (ctx.userId === campaign.createdBy) return true;
  const perms = ctx.interaction.member?.permissions;
  if (!perms) return false;
  return (BigInt(perms) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
}

/** The human DM, or (any mode) the campaign's creator or a server manager. */
export function isDmOrManager(ctx: Ctx, campaign: Campaign): boolean {
  return (isHumanRun(campaign) && campaign.humanDm!.userId === ctx.userId) || canManage(ctx, campaign);
}

function lockedMessage(campaign: Campaign, what: string) {
  const who = isHumanRun(campaign) ? `<@${campaign.humanDm!.userId}>` : "the DM";
  return `🔒 In this campaign only the Dungeon Master can change ${what}. Ask ${who}.`;
}

/** Blocks a player from editing `what` on a character that's in this channel's campaign. */
export async function guardCharacterEdit(ctx: Ctx, characterId: string, what: string): Promise<void> {
  const campaign = await getCampaign(ctx.store, ctx.channelId);
  if (!campaign || !campaign.party.some((p) => p.characterId === characterId)) return;
  if (isDmOrManager(ctx, campaign)) return;
  throw new UserError(lockedMessage(campaign, what));
}

/** Blocks DM-only actions (like running monsters) while a campaign runs in this channel. */
export async function guardDmAction(ctx: Ctx, what: string): Promise<void> {
  const campaign = await getCampaign(ctx.store, ctx.channelId);
  if (!campaign || isDmOrManager(ctx, campaign)) return;
  throw new UserError(lockedMessage(campaign, what));
}
