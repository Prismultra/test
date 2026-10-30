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
  /** Send less context per call (for providers with tight token-per-minute limits). */
  lean?: boolean;
  /** Shown in /dm status. */
  label?: string;
}

export class AnthropicDmModel implements DmModel {
  private client: Anthropic;
  readonly label: string;

  constructor(
    apiKey: string,
    private model: string,
    private effort: Config["dmEffort"],
  ) {
    // Kept well inside the function's 300s limit: at most 2 attempts of 90s each.
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
    this.label = `Claude (${model})`;
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
