/**
 * Deterministic pseudo-random source (mulberry32).
 * Everything the generator randomises goes through this so a seed fully reproduces a batch.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(arr: readonly T[]): T;
  /** True with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean;
  /** Fisher-Yates copy; the input is never mutated. */
  shuffle<T>(arr: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`rng.int: max (${max}) is below min (${min})`);
    return min + Math.floor(next() * (max - min + 1));
  };

  return {
    next,
    int,
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error("rng.pick: array is empty");
      return arr[int(0, arr.length - 1)] as T;
    },
    chance(p: number): boolean {
      return next() < Math.min(1, Math.max(0, p));
    },
    shuffle<T>(arr: readonly T[]): T[] {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        const a = out[i] as T;
        out[i] = out[j] as T;
        out[j] = a;
      }
      return out;
    },
  };
}
