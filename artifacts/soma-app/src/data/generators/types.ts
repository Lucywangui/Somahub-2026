import type { GradeBand } from "@/data/grade";

export interface Question {
  text: string;
  options: [string, string, string, string];
  correct: number; // 0-3
  /** Short worked reason the correct answer is right — shown after answering. */
  explanation?: string;
  /** Catalogue topics this question belongs to (used to keep topical quizzes on topic). */
  topics?: string[];
}

/** Context handed to every subject generator. */
export interface GenContext {
  subject: string;
  gradeKey: string;
  /** Exact grade 1–12 (8-4-4 forms mapped onto 9–12). */
  grade: number;
  band: GradeBand;
  /** Topics attached to the material being opened. */
  topics: string[];
  /** Seeded PRNG in [0, 1). Deterministic for a given material+attempt seed. */
  rng: () => number;
}

/**
 * A subject generator returns a POOL of freshly built questions (more than the
 * quiz needs). The engine dedupes by text and samples the requested count, so
 * pools should aim for 35+ varied items per (subject, grade).
 */
export type SubjectGenerator = (ctx: GenContext) => Question[];
