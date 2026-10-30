import { randomUUID } from "node:crypto";
import type { Character } from "../game/character.js";
import { keys, update, type Store } from "../store/store.js";
import { UserError } from "../discord/ui.js";
import { normalize } from "../srd/index.js";

export const newCharacterId = () => randomUUID().replace(/-/g, "").slice(0, 10);

export async function listCharacters(store: Store, guildId: string, userId: string): Promise<Character[]> {
  const entries = await store.list<Character>(keys.characterPrefix(guildId, userId), 50);
  return entries.map((e) => e.value).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getActiveId(store: Store, guildId: string, userId: string): Promise<string | undefined> {
  return (await store.get<{ id: string }>(keys.activeCharacter(guildId, userId)))?.value.id;
}

export async function setActive(store: Store, guildId: string, userId: string, id: string) {
  await store.put(keys.activeCharacter(guildId, userId), { id });
}

/** The user's active character; falls back to their only character. */
export async function getActive(store: Store, guildId: string, userId: string): Promise<Character | undefined> {
  const id = await getActiveId(store, guildId, userId);
  if (id) {
    const c = await store.get<Character>(keys.character(guildId, userId, id));
    if (c) return c.value;
  }
  const all = await listCharacters(store, guildId, userId);
  return all.length === 1 ? all[0] : undefined;
}

export async function requireActive(store: Store, guildId: string, userId: string): Promise<Character> {
  const c = await getActive(store, guildId, userId);
  if (c) return c;
  const all = await listCharacters(store, guildId, userId);
  if (all.length === 0) throw new UserError("You don't have a character here yet. Make one with `/char create`.");
  throw new UserError("Pick your active character first with `/char use`.");
}

/** Finds a character by id (what autocomplete sends) or by name. */
export function findOwnCharacter(chars: Character[], query: string): Character | undefined {
  const byId = chars.find((c) => c.id === query.trim());
  if (byId) return byId;
  const exact = chars.find((c) => c.name.trim().toLowerCase() === query.trim().toLowerCase());
  if (exact) return exact;
  // Fuzzy matching only when the query has letters or digits left after normalizing.
  const q = normalize(query);
  if (!q) return undefined;
  return chars.find((c) => normalize(c.name) === q) ?? chars.find((c) => normalize(c.name).startsWith(q));
}

export const characterKey = (c: Pick<Character, "guildId" | "ownerId" | "id">) => keys.character(c.guildId, c.ownerId, c.id);

/**
 * Applies `fn` to the latest stored copy of a character with optimistic
 * concurrency, so two edits at once (say, the AI DM and the player) don't clobber
 * each other. Returns the updated character and fn's result.
 */
export async function editCharacter<R>(
  store: Store,
  ref: Pick<Character, "guildId" | "ownerId" | "id">,
  fn: (c: Character) => R,
  now = new Date(),
): Promise<{ char: Character; result: R }> {
  const out = await update<Character, { char: Character; result: R }>(store, characterKey(ref), (cur) => {
    if (!cur) throw new UserError("That character no longer exists.");
    const result = fn(cur);
    cur.updatedAt = now.toISOString();
    return { value: cur, result: { char: cur, result } };
  });
  return out!;
}
