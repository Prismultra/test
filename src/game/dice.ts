import { randomInt } from "node:crypto";

/**
 * Dice notation supported (case-insensitive, spaces ignored):
 *   NdS        roll N dice with S sides (N defaults to 1; S may be "%" for 100)
 *   khN / klN  keep highest / lowest N        (k = kh)
 *   dhN / dlN  drop highest / lowest N
 *   !          explode: roll again on a max result
 *   rN / roN   reroll once any die showing N or lower
 *   constants, combined with + and -
 *   a trailing word labels the term, e.g. "1d8+3 slashing + 1d6 fire"
 */

export type Rng = (sides: number) => number;

export const secureRng: Rng = (sides) => randomInt(1, sides + 1);

export class DiceError extends Error {}

export interface DiceTerm {
  kind: "dice";
  sign: 1 | -1;
  count: number;
  sides: number;
  keep?: { mode: "kh" | "kl" | "dh" | "dl"; n: number };
  explode?: boolean;
  rerollBelow?: number;
  label?: string;
}

export interface ConstTerm {
  kind: "const";
  sign: 1 | -1;
  value: number;
  label?: string;
}

export type Term = DiceTerm | ConstTerm;

export interface DieResult {
  value: number;
  kept: boolean;
  exploded?: boolean;
  rerolledFrom?: number;
}

export interface TermResult {
  term: Term;
  dice: DieResult[];
  value: number;
}

export interface RollResult {
  notation: string;
  terms: TermResult[];
  total: number;
  /** The kept face of the single d20, when the roll has exactly one. */
  natural?: number;
}

export type RollMode = "normal" | "advantage" | "disadvantage";

const LIMITS = { terms: 20, count: 100, sides: 1000, totalDice: 300, explosions: 100, length: 200 };

const TERM_RE =
  /^(?<count>\d*)d(?<sides>\d+|%)(?<mods>(?:(?:kh|kl|dh|dl|k)\d*|!|ro?\d+)*)|^(?<num>\d+)/;
const MOD_RE = /(kh|kl|dh|dl|k)(\d*)|(!)|ro?(\d+)/g;

export function parse(input: string): Term[] {
  const src = input.toLowerCase().trim();
  if (!src) throw new DiceError("Empty dice expression.");
  if (src.length > LIMITS.length) throw new DiceError("That dice expression is too long.");

  const terms: Term[] = [];
  let i = 0;
  let sign: 1 | -1 = 1;
  let expectTerm = true;

  const skipSpaces = () => {
    while (src[i] === " ") i++;
  };

  while (i < src.length) {
    skipSpaces();
    if (i >= src.length) break;
    const ch = src[i]!;

    if (ch === "+" || ch === "-") {
      if (!expectTerm) {
        expectTerm = true;
        sign = ch === "-" ? -1 : 1;
      } else if (ch === "-") {
        sign = sign === 1 ? -1 : 1;
      }
      i++;
      continue;
    }

    if (expectTerm) {
      const m = TERM_RE.exec(src.slice(i));
      if (!m || !m.groups) throw new DiceError(`I couldn't read the dice near "${src.slice(i, i + 10)}".`);
      const g = m.groups;
      if (g.num !== undefined) {
        terms.push({ kind: "const", sign, value: Number(g.num) });
      } else {
        const term: DiceTerm = {
          kind: "dice",
          sign,
          count: g.count ? Number(g.count) : 1,
          sides: g.sides === "%" ? 100 : Number(g.sides),
        };
        for (const mod of (g.mods ?? "").matchAll(MOD_RE)) {
          if (mod[1]) {
            const mode = (mod[1] === "k" ? "kh" : mod[1]) as "kh" | "kl" | "dh" | "dl";
            term.keep = { mode, n: mod[2] ? Number(mod[2]) : 1 };
          } else if (mod[3]) {
            term.explode = true;
          } else if (mod[4]) {
            term.rerollBelow = Number(mod[4]);
          }
        }
        validateDice(term);
        terms.push(term);
      }
      i += m[0].length;
      sign = 1;
      expectTerm = false;
      continue;
    }

    // A label after a term: a word of 3+ letters, possibly several words, up to the next +/-.
    const label = /^[a-z]{3,}[a-z ]*/.exec(src.slice(i));
    if (label) {
      const last = terms[terms.length - 1]!;
      last.label = label[0].trim();
      i += label[0].length;
      continue;
    }
    throw new DiceError(`Unexpected "${ch}" in dice expression.`);
  }

  if (terms.length === 0) throw new DiceError("No dice found in that expression.");
  if (expectTerm) throw new DiceError("The dice expression ends with an operator.");
  if (terms.length > LIMITS.terms) throw new DiceError("Too many terms in that expression.");
  const totalDice = terms.reduce((n, t) => n + (t.kind === "dice" ? t.count : 0), 0);
  if (totalDice > LIMITS.totalDice) throw new DiceError(`That's more than ${LIMITS.totalDice} dice.`);
  return terms;
}

function validateDice(t: DiceTerm) {
  if (t.count < 1) throw new DiceError("You need to roll at least one die.");
  if (t.count > LIMITS.count) throw new DiceError(`You can roll at most ${LIMITS.count} dice at once.`);
  if (t.sides < 1 || t.sides > LIMITS.sides) throw new DiceError(`Dice must have between 1 and ${LIMITS.sides} sides.`);
  if (t.explode && t.sides === 1) throw new DiceError("A d1 can't explode.");
  if (t.rerollBelow !== undefined && t.rerollBelow >= t.sides) throw new DiceError("That reroll would never stop.");
  if (t.keep && (t.keep.n < 0 || t.keep.n > t.count)) {
    throw new DiceError(`Can't keep or drop ${t.keep.n} of ${t.count} dice.`);
  }
}

export function termNotation(t: Term): string {
  if (t.kind === "const") return String(t.value);
  let s = `${t.count}d${t.sides}`;
  if (t.keep) s += `${t.keep.mode}${t.keep.n}`;
  if (t.explode) s += "!";
  if (t.rerollBelow !== undefined) s += `ro${t.rerollBelow}`;
  return s;
}

export function notation(terms: Term[]): string {
  return terms
    .map((t, idx) => {
      const body = termNotation(t) + (t.label ? ` ${t.label}` : "");
      if (idx === 0) return t.sign === -1 ? `-${body}` : body;
      return `${t.sign === -1 ? " - " : " + "}${body}`;
    })
    .join("");
}

/** Applies advantage or disadvantage to the first plain d20 in the expression. */
export function applyMode(terms: Term[], mode: RollMode): Term[] {
  if (mode === "normal") return terms;
  let applied = false;
  return terms.map((t) => {
    if (applied || t.kind !== "dice" || t.sides !== 20 || t.count !== 1 || t.keep) return t;
    applied = true;
    return { ...t, count: 2, keep: { mode: mode === "advantage" ? "kh" : "kl", n: 1 } };
  });
}

/** Doubles the number of dice rolled, as for a critical hit. */
export function critical(terms: Term[]): Term[] {
  return terms.map((t) => (t.kind === "dice" ? { ...t, count: Math.min(t.count * 2, LIMITS.count) } : t));
}

function rollDice(t: DiceTerm, rng: Rng): DieResult[] {
  const dice: DieResult[] = [];
  let explosions = 0;
  const rollOne = (exploded: boolean) => {
    let value = rng(t.sides);
    const die: DieResult = { value, kept: true };
    if (exploded) die.exploded = true;
    if (t.rerollBelow !== undefined && value <= t.rerollBelow) {
      die.rerolledFrom = value;
      value = rng(t.sides);
      die.value = value;
    }
    dice.push(die);
    if (t.explode && value === t.sides && explosions < LIMITS.explosions) {
      explosions++;
      rollOne(true);
    }
  };
  for (let n = 0; n < t.count; n++) rollOne(false);

  if (t.keep) {
    const order = dice.map((d, idx) => ({ v: d.value, idx })).sort((a, b) => a.v - b.v || a.idx - b.idx);
    const { mode, n } = t.keep;
    let dropped: { idx: number }[];
    if (mode === "kh") dropped = order.slice(0, Math.max(0, order.length - n));
    else if (mode === "kl") dropped = order.slice(n);
    else if (mode === "dh") dropped = order.slice(Math.max(0, order.length - n));
    else dropped = order.slice(0, n);
    for (const d of dropped) dice[d.idx]!.kept = false;
  }
  return dice;
}

export function evaluate(terms: Term[], rng: Rng = secureRng): RollResult {
  const results: TermResult[] = terms.map((term) => {
    if (term.kind === "const") return { term, dice: [], value: term.sign * term.value };
    const dice = rollDice(term, rng);
    const sum = dice.filter((d) => d.kept).reduce((s, d) => s + d.value, 0);
    return { term, dice, value: term.sign * sum };
  });
  const total = results.reduce((s, r) => s + r.value, 0);
  const result: RollResult = { notation: notation(terms), terms: results, total };

  const d20s = results.filter((r) => r.term.kind === "dice" && r.term.sides === 20);
  if (d20s.length === 1) {
    const kept = d20s[0]!.dice.filter((d) => d.kept);
    if (kept.length === 1) result.natural = kept[0]!.value;
  }
  return result;
}

export function roll(expression: string, opts: { mode?: RollMode; crit?: boolean; rng?: Rng } = {}): RollResult {
  let terms = parse(expression);
  if (opts.crit) terms = critical(terms);
  terms = applyMode(terms, opts.mode ?? "normal");
  return evaluate(terms, opts.rng);
}

/** Splits a "d20 adv" / "1d20+5 disadvantage" style suffix off an expression. */
export function extractMode(expression: string): { expression: string; mode: RollMode } {
  const m = /\s+(adv|advantage|dis|disadv|disadvantage)\s*$/i.exec(expression);
  if (!m) return { expression, mode: "normal" };
  const word = m[1]!.toLowerCase();
  return {
    expression: expression.slice(0, m.index),
    mode: word.startsWith("adv") ? "advantage" : "disadvantage",
  };
}

const MAX_SHOWN_DICE = 40;

/** Renders the individual dice, e.g. "(**20**, ~~3~~) + 5". Uses Discord markdown. */
export function formatBreakdown(result: RollResult): string {
  const parts = result.terms.map((r, idx) => {
    const op = idx === 0 ? (r.term.sign === -1 ? "-" : "") : r.term.sign === -1 ? " - " : " + ";
    const label = r.term.label ? ` ${r.term.label}` : "";
    if (r.term.kind === "const") return `${op}${r.term.value}${label}`;
    const sides = r.term.sides;
    const shown = r.dice.slice(0, MAX_SHOWN_DICE).map((d) => {
      let s = String(d.value);
      if (d.value === sides || (sides === 20 && d.value === 1)) s = `**${s}**`;
      if (d.rerolledFrom !== undefined) s = `~~${d.rerolledFrom}~~→${s}`;
      if (d.exploded) s = `${s}💥`;
      return d.kept ? s : `~~${s}~~`;
    });
    if (r.dice.length > MAX_SHOWN_DICE) shown.push(`…${r.dice.length - MAX_SHOWN_DICE} more`);
    return `${op}(${shown.join(", ")})${label}`;
  });
  return parts.join("");
}

/** Sums the result per damage-type label, e.g. { slashing: 7, fire: 3 }. */
export function totalsByLabel(result: RollResult): Record<string, number> {
  const out: Record<string, number> = {};
  let lastLabel = "";
  // Walk backwards so an unlabeled modifier joins the label that follows it
  // ("1d8+3 slashing" puts the 3 into slashing).
  for (let i = result.terms.length - 1; i >= 0; i--) {
    const r = result.terms[i]!;
    if (r.term.label) lastLabel = r.term.label;
    out[lastLabel] = (out[lastLabel] ?? 0) + r.value;
  }
  return out;
}

export function average(terms: Term[]): number {
  return terms.reduce((sum, t) => {
    if (t.kind === "const") return sum + t.sign * t.value;
    const kept = t.keep ? (t.keep.mode.startsWith("k") ? t.keep.n : t.count - t.keep.n) : t.count;
    return sum + t.sign * kept * ((t.sides + 1) / 2);
  }, 0);
}
