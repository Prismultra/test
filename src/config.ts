export interface Config {
  discordPublicKey: string;
  discordAppId: string;
  discordBotToken?: string;
  anthropicApiKey?: string;
  dmModel: string;
  dmEffort: "low" | "medium" | "high" | "xhigh" | "max";
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`Missing required environment variable ${name}`);
    return v;
  };
  const optional = (name: string) => env[name]?.trim() || undefined;
  const effort = optional("DM_EFFORT") ?? "medium";
  const config: Config = {
    discordPublicKey: required("DISCORD_PUBLIC_KEY"),
    discordAppId: required("DISCORD_APPLICATION_ID"),
    dmModel: optional("DM_MODEL") ?? "claude-opus-5-5",
    dmEffort: (EFFORTS as readonly string[]).includes(effort) ? (effort as Config["dmEffort"]) : "medium",
  };
  const set = <K extends keyof Config>(k: K, v: Config[K] | undefined) => {
    if (v !== undefined) config[k] = v;
  };
  set("discordBotToken", optional("DISCORD_BOT_TOKEN"));
  set("anthropicApiKey", optional("ANTHROPIC_API_KEY"));
  set("supabaseUrl", optional("SUPABASE_URL"));
  set("supabaseServiceRoleKey", optional("SUPABASE_SERVICE_ROLE_KEY"));
  return config;
}
