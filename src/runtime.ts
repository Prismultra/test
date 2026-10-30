import type { Config } from "./config.js";
import type { Deps } from "./discord/context.js";
import { DiscordRest } from "./discord/api.js";
import { MemoryStore } from "./store/memory.js";
import { SupabaseStore } from "./store/supabase.js";
import { AnthropicDmModel } from "./ai/model.js";

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
  if (config.anthropicApiKey) deps.dm = new AnthropicDmModel(config.anthropicApiKey, config.dmModel, config.dmEffort);
  return deps;
}
