import type { Question } from "./types";

// ── Seeded PRNG ──────────────────────────────────────────────────────────────
export function makeRng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Small RNG utilities ──────────────────────────────────────────────────────
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function shuffle<T>(rng: () => number, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Sample up to `n` distinct items. */
export function sample<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  return shuffle(rng, arr).slice(0, n);
}

// ── Question building ────────────────────────────────────────────────────────

/**
 * Build a multiple-choice Question from a correct answer + distractor pool.
 * Picks 3 distinct distractors, places the correct answer at a random slot,
 * and guarantees four non-empty, unique options. Returns null if it cannot
 * assemble four distinct options.
 */
export function buildMCQ(
  rng: () => number,
  text: string,
  correct: string,
  distractorPool: readonly string[],
  explanation?: string,
): Question | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const correctClean = String(correct).trim();
  if (!correctClean) return null;

  const seen = new Set([norm(correctClean)]);
  const distractors: string[] = [];
  for (const d of shuffle(rng, distractorPool)) {
    const c = String(d).trim();
    if (!c || seen.has(norm(c))) continue;
    seen.add(norm(c));
    distractors.push(c);
    if (distractors.length === 3) break;
  }
  if (distractors.length < 3) return null;

  const slot = Math.floor(rng() * 4);
  const options: string[] = [];
  let di = 0;
  for (let i = 0; i < 4; i++) {
    if (i === slot) options.push(correctClean);
    else options.push(distractors[di++]);
  }
  return { text, options: options as [string, string, string, string], correct: slot, explanation };
}

/** Numeric MCQ: correct value plus near-miss numeric distractors. */
export function numericMCQ(
  rng: () => number,
  text: string,
  answer: number,
  opts: { spread?: number; unit?: string; allowNegative?: boolean; explanation?: string } = {},
): Question | null {
  const { spread = Math.max(1, Math.round(Math.abs(answer) * 0.15) || 2), unit = "", allowNegative = true, explanation } = opts;
  const fmt = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return unit ? `${rounded} ${unit}` : String(rounded);
  };
  const seen = new Set<number>([answer]);
  const pool: number[] = [];
  const candidates = [
    answer + spread, answer - spread, answer + 2 * spread, answer - 2 * spread,
    answer + 1, answer - 1, Math.round(answer * 1.1), Math.round(answer * 0.9),
    answer + spread * 3, Math.round(answer / 2),
  ];
  for (const c of shuffle(rng, candidates)) {
    if (seen.has(c)) continue;
    if (!allowNegative && c < 0) continue;
    seen.add(c);
    pool.push(c);
    if (pool.length === 3) break;
  }
  if (pool.length < 3) return null;
  return buildMCQ(rng, text, fmt(answer), pool.map(fmt), explanation ?? `The answer is ${fmt(answer)}.`);
}

/** Normalised key used by the engine to dedupe questions across generators. */
export function questionKey(q: Question): string {
  return q.text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Re-shuffle option order in place while keeping `correct` pointing at the answer. */
export function shuffleOptions(rng: () => number, q: Question): Question {
  const correctValue = q.options[q.correct];
  const shuffled = shuffle(rng, q.options) as [string, string, string, string];
  return { text: q.text, options: shuffled, correct: shuffled.indexOf(correctValue), explanation: q.explanation, topics: q.topics };
}
