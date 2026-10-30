import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaTool = Anthropic.Beta.BetaTool;
export type BetaTextBlockParam = Anthropic.Beta.BetaTextBlockParam;
export type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
export type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export interface ModelRequest {
  system: BetaTextBlockParam[];
  messages: BetaMessageParam[];
  tools?: BetaTool[];
  maxTokens?: number;
  effort?: Config["dmEffort"];
}

/** The one call the Dungeon Master makes. Tests substitute a scripted fake. */
export interface DmModel {
  create(req: ModelRequest): Promise<BetaMessage>;
}

export class AnthropicDmModel implements DmModel {
  private client: Anthropic;

  constructor(
    apiKey: string,
    private model: string,
    private effort: Config["dmEffort"],
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  create(req: ModelRequest): Promise<BetaMessage> {
    return this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      // If the model declines for policy reasons, retry server-side on Anthropic's recommended fallback.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? this.effort },
      system: req.system,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
    });
  }
}
