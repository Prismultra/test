import { describe, expect, it } from "vitest";
import {
  DiceError,
  applyMode,
  average,
  critical,
  evaluate,
  extractMode,
  formatBreakdown,
  notation,
  parse,
  roll,
  totalsByLabel,
  type Rng,
} from "../src/game/dice.js";

/** Returns the given faces in order, then repeats the last one. */
const seq = (...faces: number[]): Rng => {
  let i = 0;
  return () => faces[Math.min(i++, faces.length - 1)]!;
};

describe("parse", () => {
  it("parses simple and compound expressions", () => {
    expect(notation(parse("d20"))).toBe("1d20");
    expect(notation(parse("2d6 + 3"))).toBe("2d6 + 3");
    expect(notation(parse("1d8+1d6-2"))).toBe("1d8 + 1d6 - 2");
    expect(notation(parse("d%"))).toBe("1d100");
    expect(notation(parse("-1d4"))).toBe("-1d4");
  });

  it("parses keep/drop, explode and reroll modifiers", () => {
    expect(notation(parse("4d6dl1"))).toBe("4d6dl1");
    expect(notation(parse("2d20k1"))).toBe("2d20kh1");
    expect(notation(parse("2d20kl"))).toBe("2d20kl1");
    expect(notation(parse("3d6!"))).toBe("3d6!");
    expect(notation(parse("2d6r2"))).toBe("2d6ro2");
  });

  it("keeps damage type labels", () => {
    const terms = parse("1d8+3 slashing + 1d6 fire");
    expect(terms.map((t) => t.label)).toEqual([undefined, "slashing", "fire"]);
  });

  it("rejects nonsense and abuse", () => {
    for (const bad of ["", "d", "2d", "1d20+", "abc", "1000d6", "1d0", "1d2000", "1d1!", "1d6r6", "2d6kh3", "1d20 * 2"]) {
      expect(() => parse(bad), bad).toThrow(DiceError);
    }
    expect(() => parse("100d6+100d6+100d6+1d6")).toThrow(/more than/);
  });
});

describe("evaluate", () => {
  it("totals dice and constants", () => {
    const r = roll("2d6+3", { rng: seq(4, 5) });
    expect(r.total).toBe(12);
    expect(formatBreakdown(r)).toBe("(4, 5) + 3");
  });

  it("drops the lowest die", () => {
    const r = roll("4d6dl1", { rng: seq(3, 6, 1, 4) });
    expect(r.total).toBe(13);
    expect(formatBreakdown(r)).toBe("(3, **6**, ~~1~~, 4)");
  });

  it("handles keep highest/lowest with ties deterministically", () => {
    expect(roll("2d20kh1", { rng: seq(7, 7) }).total).toBe(7);
    expect(roll("3d6kl2", { rng: seq(5, 2, 6) }).total).toBe(7);
    expect(roll("3d6dh1", { rng: seq(5, 2, 6) }).total).toBe(7);
  });

  it("explodes on max", () => {
    const r = roll("1d6!", { rng: seq(6, 6, 2) });
    expect(r.total).toBe(14);
    expect(r.terms[0]!.dice).toHaveLength(3);
  });

  it("rerolls low dice once", () => {
    const r = roll("2d6ro2", { rng: seq(1, 1, 5) });
    // first die 1 -> rerolled to 1 (kept), second die 5
    expect(r.total).toBe(6);
    expect(r.terms[0]!.dice[0]!.rerolledFrom).toBe(1);
  });

  it("reports the natural d20", () => {
    expect(roll("1d20+5", { rng: seq(20) }).natural).toBe(20);
    expect(roll("2d20kh1", { rng: seq(3, 18) }).natural).toBe(18);
    expect(roll("1d20+1d20", { rng: seq(3, 18) }).natural).toBeUndefined();
    expect(roll("2d6", { rng: seq(3, 3) }).natural).toBeUndefined();
  });

  it("applies advantage and disadvantage to the d20", () => {
    expect(notation(applyMode(parse("1d20+5"), "advantage"))).toBe("2d20kh1 + 5");
    expect(notation(applyMode(parse("d20"), "disadvantage"))).toBe("2d20kl1");
    expect(notation(applyMode(parse("2d6"), "advantage"))).toBe("2d6");
    expect(roll("1d20+2", { mode: "disadvantage", rng: seq(15, 4) }).total).toBe(6);
  });

  it("doubles dice on a crit", () => {
    expect(notation(critical(parse("1d8+3 slashing")))).toBe("2d8 + 3 slashing");
    expect(roll("2d6+4", { crit: true, rng: seq(1, 2, 3, 4) }).total).toBe(14);
  });

  it("groups totals by damage type", () => {
    const r = roll("1d8+3 slashing + 1d6 fire", { rng: seq(5, 2) });
    expect(totalsByLabel(r)).toEqual({ slashing: 8, fire: 2 });
  });

  it("uses a secure RNG within range by default", () => {
    for (let i = 0; i < 200; i++) {
      const r = evaluate(parse("1d20"));
      expect(r.total).toBeGreaterThanOrEqual(1);
      expect(r.total).toBeLessThanOrEqual(20);
    }
  });
});

describe("helpers", () => {
  it("extracts trailing advantage words", () => {
    expect(extractMode("1d20+5 adv")).toEqual({ expression: "1d20+5", mode: "advantage" });
    expect(extractMode("d20 disadvantage")).toEqual({ expression: "d20", mode: "disadvantage" });
    expect(extractMode("2d6 fire")).toEqual({ expression: "2d6 fire", mode: "normal" });
  });

  it("computes averages", () => {
    expect(average(parse("2d6+3"))).toBe(10);
    expect(average(parse("4d6dl1"))).toBe(10.5);
  });
});
