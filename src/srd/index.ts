import { ARMOR } from "./data/armor.js";
import { CONDITIONS } from "./data/conditions.js";
import { MAGIC_ITEMS } from "./data/magic-items.js";
import { MONSTERS } from "./data/monsters.js";
import { SPELLS } from "./data/spells.js";
import { WEAPONS } from "./data/weapons.js";
import type { SrdArmor, SrdCondition, SrdMagicItem, SrdMonster, SrdSpell, SrdWeapon } from "./types.js";

export type { SrdArmor, SrdCondition, SrdMagicItem, SrdMonster, SrdSpell, SrdWeapon } from "./types.js";
export { ARMOR, CONDITIONS, MAGIC_ITEMS, MONSTERS, SPELLS, WEAPONS };

export const SRD_ATTRIBUTION =
  'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC, ' +
  "available at https://dnd.wizards.com/resources/systems-reference-document. " +
  "The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License.";

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

interface Named {
  id: string;
  name: string;
}

/**
 * Ranks entries by how well their name matches the query: exact, prefix,
 * word prefix, substring, then in-order subsequence. Returns at most `limit`.
 */
export function searchByName<T extends Named>(items: readonly T[], query: string, limit = 25): T[] {
  const q = normalize(query);
  if (!q) return items.slice(0, limit);
  const qWords = q.split(" ");
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const name = normalize(item.name);
    let score = 0;
    if (name === q || item.id === q.replace(/ /g, "-")) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (qWords.every((w) => name.split(" ").some((nw) => nw.startsWith(w)))) score = 60;
    else if (name.includes(q)) score = 40;
    else if (isSubsequence(q.replace(/ /g, ""), name.replace(/ /g, ""))) score = 10;
    if (score > 0) scored.push({ item, score: score - name.length / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Finds one entry by id or name, falling back to the best fuzzy match. */
export function findByName<T extends Named>(items: readonly T[], query: string): T | undefined {
  const q = normalize(query);
  if (!q) return undefined;
  const id = q.replace(/ /g, "-");
  return items.find((i) => i.id === id) ?? items.find((i) => normalize(i.name) === q) ?? searchByName(items, query, 1)[0];
}

export const findMonster = (q: string): SrdMonster | undefined => findByName(MONSTERS, q);
export const findSpell = (q: string): SrdSpell | undefined => findByName(SPELLS, q);
export const findCondition = (q: string): SrdCondition | undefined => findByName(CONDITIONS, q);
export const findMagicItem = (q: string): SrdMagicItem | undefined => findByName(MAGIC_ITEMS, q);
export const findWeapon = (q: string): SrdWeapon | undefined => findByName(WEAPONS, q);
export const findArmor = (q: string): SrdArmor | undefined => findByName(ARMOR, q);

export function crText(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}
