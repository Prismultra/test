import type { Entry, Store, Versioned, WriteCondition } from "./store.js";

/** In-process store for tests and local development. */
export class MemoryStore implements Store {
  private data = new Map<string, { json: string; version: number }>();

  async get<T>(key: string): Promise<Versioned<T> | undefined> {
    const row = this.data.get(key);
    return row ? { value: JSON.parse(row.json) as T, version: row.version } : undefined;
  }

  async put<T>(key: string, value: T, condition: WriteCondition = "any"): Promise<number | undefined> {
    const row = this.data.get(key);
    if (condition === "create" && row) return undefined;
    if (typeof condition === "number" && row?.version !== condition) return undefined;
    const version = (row?.version ?? 0) + 1;
    this.data.set(key, { json: JSON.stringify(value), version });
    return version;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list<T>(prefix: string, limit = 100): Promise<Entry<T>[]> {
    const out: Entry<T>[] = [];
    for (const [key, row] of [...this.data.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith(prefix)) continue;
      out.push({ key, value: JSON.parse(row.json) as T, version: row.version });
      if (out.length >= limit) break;
    }
    return out;
  }
}
