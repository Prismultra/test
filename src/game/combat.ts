import { roll, type Rng } from "./dice.js";
import { abilityMod } from "./rules.js";
import type { SrdMonster } from "../srd/types.js";

export interface Combatant {
  id: string;
  name: string;
  initiative: number;
  initBonus: number;
  isPlayer: boolean;
  hp?: number;
  maxHp?: number;
  ac?: number;
  ownerId?: string;
  characterId?: string;
  monsterId?: string;
  conditions: string[];
}

export interface Combat {
  channelId: string;
  guildId: string;
  createdBy: string;
  round: number;
  /** Index into combatants of whose turn it is. */
  turn: number;
  combatants: Combatant[];
  hideMonsterHp: boolean;
  messageId?: string;
  nextId: number;
  log: string[];
  createdAt: string;
  updatedAt: string;
}

export const MAX_COMBATANTS = 40;

export function createCombat(opts: {
  channelId: string;
  guildId: string;
  createdBy: string;
  hideMonsterHp?: boolean;
  now?: string;
}): Combat {
  const now = opts.now ?? new Date().toISOString();
  return {
    channelId: opts.channelId,
    guildId: opts.guildId,
    createdBy: opts.createdBy,
    round: 1,
    turn: 0,
    combatants: [],
    hideMonsterHp: opts.hideMonsterHp ?? true,
    nextId: 1,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

const compare = (a: Combatant, b: Combatant) =>
  b.initiative - a.initiative || b.initBonus - a.initBonus || Number(b.isPlayer) - Number(a.isPlayer) || a.name.localeCompare(b.name);

export function current(c: Combat): Combatant | undefined {
  return c.combatants[c.turn];
}

export type NewCombatant = Omit<Combatant, "id" | "initiative" | "conditions"> & {
  initiative?: number;
  conditions?: string[];
};

/** Inserts a combatant in initiative order, keeping the current turn on the same creature. */
export function addCombatant(c: Combat, input: NewCombatant, rng?: Rng): Combatant {
  if (c.combatants.length >= MAX_COMBATANTS) throw new Error(`A combat can have at most ${MAX_COMBATANTS} combatants.`);
  const active = current(c);
  const initiative =
    input.initiative ?? roll(`1d20${input.initBonus >= 0 ? "+" : ""}${input.initBonus}`, rng ? { rng } : {}).total;
  const combatant: Combatant = {
    ...input,
    id: String(c.nextId++),
    name: uniqueName(c, input.name),
    initiative,
    conditions: input.conditions ?? [],
  };
  c.combatants.push(combatant);
  c.combatants.sort(compare);
  if (active) c.turn = c.combatants.indexOf(active);
  return combatant;
}

function uniqueName(c: Combat, name: string): string {
  const base = name.trim().slice(0, 40) || "Combatant";
  const taken = new Set(c.combatants.map((x) => x.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Adds `count` copies of an SRD monster, rolling HP and initiative for each. */
export function addMonsters(
  c: Combat,
  monster: SrdMonster,
  count: number,
  opts: { rollHp?: boolean; rng?: Rng; name?: string } = {},
): Combatant[] {
  const added: Combatant[] = [];
  const n = Math.min(Math.max(1, count), MAX_COMBATANTS - c.combatants.length);
  if (n <= 0) throw new Error(`A combat can have at most ${MAX_COMBATANTS} combatants.`);
  const base = opts.name?.trim() || monster.name;
  for (let i = 0; i < n; i++) {
    let hp = monster.hp;
    if (opts.rollHp) {
      try {
        hp = Math.max(1, roll(monster.hpRoll, opts.rng ? { rng: opts.rng } : {}).total);
      } catch {
        hp = monster.hp;
      }
    }
    const name = count > 1 ? `${base} ${letter(i)}` : base;
    added.push(
      addCombatant(
        c,
        {
          name,
          initBonus: abilityMod(monster.abilities[1]),
          isPlayer: false,
          hp,
          maxHp: hp,
          ac: monster.ac,
          monsterId: monster.id,
        },
        opts.rng,
      ),
    );
  }
  return added;
}

const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

export function findCombatant(c: Combat, query: string): Combatant | undefined {
  const q = query.trim().toLowerCase();
  return (
    c.combatants.find((x) => x.id === q) ??
    c.combatants.find((x) => x.name.toLowerCase() === q) ??
    c.combatants.find((x) => x.name.toLowerCase().startsWith(q)) ??
    c.combatants.find((x) => x.name.toLowerCase().includes(q))
  );
}

export function removeCombatant(c: Combat, id: string): Combatant | undefined {
  const idx = c.combatants.findIndex((x) => x.id === id);
  if (idx < 0) return undefined;
  const [removed] = c.combatants.splice(idx, 1);
  if (idx < c.turn) c.turn--;
  if (c.turn >= c.combatants.length) {
    c.turn = 0;
    if (c.combatants.length) c.round++;
  }
  return removed;
}

export const isDown = (x: Combatant) => x.hp !== undefined && x.hp <= 0;

/** Advances to the next turn. Monsters at 0 HP are skipped; players are not (death saves). */
export function nextTurn(c: Combat): Combatant | undefined {
  if (c.combatants.length === 0) return undefined;
  for (let step = 0; step < c.combatants.length; step++) {
    c.turn++;
    if (c.turn >= c.combatants.length) {
      c.turn = 0;
      c.round++;
    }
    const who = c.combatants[c.turn]!;
    if (who.isPlayer || !isDown(who)) return who;
  }
  return current(c);
}

export function prevTurn(c: Combat): Combatant | undefined {
  if (c.combatants.length === 0) return undefined;
  if (c.turn === 0) {
    if (c.round > 1) {
      c.round--;
      c.turn = c.combatants.length - 1;
    }
  } else {
    c.turn--;
  }
  return current(c);
}

export function damageCombatant(x: Combatant, amount: number): number | undefined {
  if (x.hp === undefined) return undefined;
  x.hp = Math.max(0, x.hp - Math.max(0, Math.floor(amount)));
  return x.hp;
}

export function healCombatant(x: Combatant, amount: number): number | undefined {
  if (x.hp === undefined) return undefined;
  x.hp = Math.min(x.maxHp ?? Infinity, x.hp + Math.max(0, Math.floor(amount)));
  return x.hp;
}

export function healthStatus(x: Combatant): string {
  if (x.hp === undefined || x.maxHp === undefined) return "";
  if (x.hp <= 0) return "Down";
  if (x.hp === x.maxHp) return "Unhurt";
  if (x.hp > x.maxHp / 2) return "Hurt";
  return "Bloodied";
}

export function pushLog(c: Combat, line: string) {
  c.log.push(line);
  if (c.log.length > 8) c.log.splice(0, c.log.length - 8);
}

export function renderOrder(c: Combat, opts: { revealHp?: boolean } = {}): string {
  if (c.combatants.length === 0) return "_No combatants yet. Use `/init join` or `/init add`._";
  return c.combatants
    .map((x, idx) => {
      const marker = idx === c.turn ? "▶️" : isDown(x) ? "💀" : "▫️";
      const who = idx === c.turn ? `**${x.name}**` : x.name;
      let hp = "";
      if (x.hp !== undefined) {
        const showExact = x.isPlayer || !c.hideMonsterHp || opts.revealHp;
        hp = showExact ? ` · ${x.hp}/${x.maxHp} HP` : ` · ${healthStatus(x)}`;
      }
      const ac = x.ac !== undefined && (x.isPlayer || opts.revealHp) ? ` · AC ${x.ac}` : "";
      const cond = x.conditions.length ? ` · _${x.conditions.join(", ")}_` : "";
      return `${marker} \`${String(x.initiative).padStart(2)}\` ${who}${hp}${ac}${cond}`;
    })
    .join("\n");
}
