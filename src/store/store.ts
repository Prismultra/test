export interface Versioned<T> {
  value: T;
  version: number;
}

export interface Entry<T> extends Versioned<T> {
  key: string;
}

/**
 * How a write is conditioned:
 *  - "any": unconditional upsert
 *  - "create": only if the key doesn't exist
 *  - a number: only if the stored version equals it (compare-and-set)
 */
export type WriteCondition = "any" | "create" | number;

/** A small versioned key-value store. Values are JSON. */
export interface Store {
  get<T>(key: string): Promise<Versioned<T> | undefined>;
  /** Returns the new version, or undefined if the condition failed. */
  put<T>(key: string, value: T, condition?: WriteCondition): Promise<number | undefined>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string, limit?: number): Promise<Entry<T>[]>;
}

export class ConflictError extends Error {
  constructor(key: string) {
    super(`Too many concurrent updates to ${key}; try again.`);
  }
}

/**
 * Read-modify-write with optimistic concurrency. `fn` receives the current
 * value (or undefined) and returns the new value, or undefined to skip writing.
 */
export async function update<T, R = T>(
  store: Store,
  key: string,
  fn: (current: T | undefined) => { value: T; result: R } | undefined | Promise<{ value: T; result: R } | undefined>,
  attempts = 5,
): Promise<R | undefined> {
  for (let i = 0; i < attempts; i++) {
    const cur = await store.get<T>(key);
    const next = await fn(cur ? structuredClone(cur.value) : undefined);
    if (!next) return undefined;
    const ok = await store.put(key, next.value, cur ? cur.version : "create");
    if (ok !== undefined) return next.result;
  }
  throw new ConflictError(key);
}

export const keys = {
  character: (guildId: string, userId: string, charId: string) => `char:${guildId}:${userId}:${charId}`,
  characterPrefix: (guildId: string, userId: string) => `char:${guildId}:${userId}:`,
  activeCharacter: (guildId: string, userId: string) => `active:${guildId}:${userId}`,
  combat: (channelId: string) => `combat:${channelId}`,
  campaign: (channelId: string) => `campaign:${channelId}`,
};
