import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Entry, Store, Versioned, WriteCondition } from "./store.js";

/**
 * Store backed by the `kv` table and `kv_put` function in
 * supabase/migrations/0001_kv.sql. Uses the service role key, so it must only
 * run server-side.
 */
export class SupabaseStore implements Store {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async get<T>(key: string): Promise<Versioned<T> | undefined> {
    const { data, error } = await this.db.from("kv").select("value, version").eq("key", key).maybeSingle();
    if (error) throw new Error(`Store get failed: ${error.message}`);
    return data ? { value: data.value as T, version: data.version as number } : undefined;
  }

  async put<T>(key: string, value: T, condition: WriteCondition = "any"): Promise<number | undefined> {
    const { data, error } = await this.db.rpc("kv_put", {
      p_key: key,
      p_value: value,
      p_mode: typeof condition === "number" ? "cas" : condition,
      p_expected: typeof condition === "number" ? condition : null,
    });
    if (error) throw new Error(`Store put failed: ${error.message}`);
    return data === null ? undefined : (data as number);
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.db.from("kv").delete().eq("key", key);
    if (error) throw new Error(`Store delete failed: ${error.message}`);
  }

  async list<T>(prefix: string, limit = 100): Promise<Entry<T>[]> {
    const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { data, error } = await this.db
      .from("kv")
      .select("key, value, version")
      .like("key", pattern)
      .order("key")
      .limit(limit);
    if (error) throw new Error(`Store list failed: ${error.message}`);
    return (data ?? []).map((row) => ({ key: row.key as string, value: row.value as T, version: row.version as number }));
  }
}
