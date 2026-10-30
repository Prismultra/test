import type { Config } from "./config.js";
import type { Deps } from "./discord/context.js";
import { DiscordRest } from "./discord/api.js";
import { MemoryStore } from "./store/memory.js";
import { SupabaseStore } from "./store/supabase.js";
import { AnthropicDmModel, type DmModel } from "./ai/model.js";
import { GroqDmModel } from "./ai/groq.js";

/** Picks the Dungeon Master's AI: Claude if configured, else Groq's free tier, else none. */
export function createDmModel(config: Config): DmModel | undefined {
  const anthropic = () => new AnthropicDmModel(config.anthropicApiKey!, config.dmModel, config.dmEffort);
  const groq = () => new GroqDmModel(config.groqApiKey!, config.groqModel);
  if (config.dmProvider === "anthropic") return config.anthropicApiKey ? anthropic() : undefined;
  if (config.dmProvider === "groq") return config.groqApiKey ? groq() : undefined;
  if (config.anthropicApiKey) return anthropic();
  if (config.groqApiKey) return groq();
  return undefined;
}

export function createDeps(config: Config, waitUntil: Deps["waitUntil"]): Deps {
  let store: Deps["store"];
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    store = new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey);
  } else {
    console.warn(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: using in-memory storage. Characters and campaigns will be lost on restart.",
    );
    store = new MemoryStore();
  }
  const deps: Deps = { config, store, discord: new DiscordRest(config.discordAppId), waitUntil };
  const dm = createDmModel(config);
  if (dm) deps.dm = dm;
  return deps;
}
