import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeClaudeError } from "../src/ai/model.js";
import { UserError } from "../src/discord/ui.js";

const apiError = (status: number, message: string) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

describe("Claude errors", () => {
  it("explain themselves to players", () => {
    const msg = (e: unknown) => (describeClaudeError(e) as Error).message;
    expect(msg(apiError(401, "invalid x-api-key"))).toContain("ANTHROPIC_API_KEY");
    expect(msg(apiError(400, "Your credit balance is too low to access the Anthropic API."))).toContain("out of API credit");
    expect(msg(apiError(429, "rate limited"))).toContain("rate-limited");
    expect(msg(apiError(529, "Overloaded"))).toContain("having trouble");
    expect(msg(apiError(404, "model: claude-nope not found"))).toContain("model: claude-nope not found");
    expect(describeClaudeError(apiError(400, "x"))).toBeInstanceOf(UserError);
    const other = new TypeError("boom");
    expect(describeClaudeError(other)).toBe(other);
  });
});
