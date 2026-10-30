import type { RESTPatchAPIWebhookWithTokenMessageJSONBody, RESTPostAPIWebhookWithTokenJSONBody } from "discord-api-types/v10";

const API = "https://discord.com/api/v10";

export type MessageBody = RESTPostAPIWebhookWithTokenJSONBody & RESTPatchAPIWebhookWithTokenMessageJSONBody;

/** The subset of Discord's REST API the bot uses after responding to an interaction. */
export interface DiscordApi {
  editOriginal(token: string, body: MessageBody): Promise<void>;
  deleteOriginal(token: string): Promise<void>;
  followup(token: string, body: MessageBody): Promise<void>;
}

export class DiscordRest implements DiscordApi {
  constructor(
    private appId: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown, attempt = 0): Promise<void> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429 && attempt < 3) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, Math.ceil((data.retry_after ?? 1) * 1000)));
      return this.call(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Only the start of the path is logged: webhook paths contain the interaction token.
      throw new Error(`Discord ${method} ${path.split("/").slice(0, 3).join("/")} failed: ${res.status} ${text.slice(0, 300)}`);
    }
  }

  editOriginal(token: string, body: MessageBody) {
    return this.call("PATCH", `/webhooks/${this.appId}/${token}/messages/@original`, body);
  }

  deleteOriginal(token: string) {
    return this.call("DELETE", `/webhooks/${this.appId}/${token}/messages/@original`);
  }

  async followup(token: string, body: MessageBody) {
    // A follow-up sent right after the initial response can race it and 404; retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call("POST", `/webhooks/${this.appId}/${token}`, body);
      } catch (err) {
        if (attempt >= 3 || !String(err).includes(" 404 ")) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
}
