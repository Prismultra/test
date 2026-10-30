import type { Character } from "../game/character.js";
import type { Combat } from "../game/combat.js";
import { keys, update, type Store } from "../store/store.js";
import { UserError } from "../discord/ui.js";

export async function getCombat(store: Store, channelId: string): Promise<Combat | undefined> {
  return (await store.get<Combat>(keys.combat(channelId)))?.value;
}

export async function editCombat<R>(
  store: Store,
  channelId: string,
  fn: (c: Combat) => R,
  now = new Date(),
): Promise<{ combat: Combat; result: R }> {
  const out = await update<Combat, { combat: Combat; result: R }>(store, keys.combat(channelId), (cur) => {
    if (!cur) throw new UserError("There's no combat in this channel. Start one with `/init start`.");
    const result = fn(cur);
    cur.updatedAt = now.toISOString();
    return { value: cur, result: { combat: cur, result } };
  });
  return out!;
}

/** Mirrors a character's HP and conditions onto their combatant, if they're in this channel's combat. */
export async function syncCharacterToCombat(store: Store, channelId: string, char: Character): Promise<void> {
  const combat = await getCombat(store, channelId);
  if (!combat?.combatants.some((x) => x.characterId === char.id)) return;
  await update<Combat>(store, keys.combat(channelId), (cur) => {
    const x = cur?.combatants.find((y) => y.characterId === char.id);
    if (!cur || !x) return undefined;
    x.hp = char.hp;
    x.maxHp = char.maxHp;
    x.ac = char.ac;
    x.conditions = [...char.conditions];
    return { value: cur, result: cur };
  });
}
