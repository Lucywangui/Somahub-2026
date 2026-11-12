import { MATERIALS, type Material } from "@/data/materials";
import { resolveGrade } from "@/data/grade";
import type { GenContext, Question, SubjectGenerator } from "./types";
import { hashString, makeRng, questionKey, shuffle, shuffleOptions } from "./helpers";
import { makeFactBankGenerator, matchesTopics } from "./factbank";
import { QUESTION_BANKS } from "./banks";

import { mathematicsGenerator } from "./mathematics";
import { englishGenerator, literatureGenerator } from "./content/english";
import {
  biologyGenerator, chemistryGenerator, environmentalActivitiesGenerator,
  integratedScienceGenerator, physicsGenerator,
} from "./content/science";
import { fasihiKiswahiliGenerator, kiswahiliGenerator } from "./content/kiswahili";
import {
  businessStudiesGenerator, creGenerator, geographyGenerator,
  historyCitizenshipGenerator, socialStudiesGenerator,
} from "./content/humanities";
import {
  agricultureGenerator, agricultureNutritionGenerator, computerScienceGenerator,
  healthEducationGenerator, homeScienceGenerator, hygieneNutritionGenerator, preTechnicalGenerator,
} from "./content/practical";
import { creativeArtsAndSportsGenerator, creativeArtsGenerator } from "./content/arts";

export type { Question } from "./types";

// Exact subject-name → generator. Names must match materials.ts catalogue.
const BASE_GENERATORS: Record<string, SubjectGenerator> = {
  Mathematics: mathematicsGenerator,
  English: englishGenerator,
  Literature: literatureGenerator,
  Kiswahili: kiswahiliGenerator,
  "Fasihi ya Kiswahili": fasihiKiswahiliGenerator,
  Biology: biologyGenerator,
  Chemistry: chemistryGenerator,
  Physics: physicsGenerator,
  "Integrated Science": integratedScienceGenerator,
  "Environmental Activities": environmentalActivitiesGenerator,
  "Social Studies": socialStudiesGenerator,
  Geography: geographyGenerator,
  "History and Citizenship": historyCitizenshipGenerator,
  History: historyCitizenshipGenerator, // 8-4-4 catalogue uses the short name
  "Business Studies": businessStudiesGenerator,
  "Christian Religious Education": creGenerator,
  Agriculture: agricultureGenerator,
  "Agriculture and Nutrition": agricultureNutritionGenerator,
  "Home Science": homeScienceGenerator,
  "Hygiene and Nutrition": hygieneNutritionGenerator,
  "Health Education": healthEducationGenerator,
  "Pre-Technical Studies": preTechnicalGenerator,
  "Computer Science": computerScienceGenerator,
  "Creative Arts": creativeArtsGenerator,
  "Creative Arts and Sports": creativeArtsAndSportsGenerator,
};

/**
 * Final generator per subject: the original generator plus the authored
 * question bank for that subject (banks/<subject>/<band>.ts).
 */
export const SUBJECT_GENERATORS: Record<string, SubjectGenerator> = Object.fromEntries(
  Object.entries(BASE_GENERATORS).map(([subject, base]) => {
    const bank = QUESTION_BANKS[subject];
    if (!bank) return [subject, base];
    const fromBank = makeFactBankGenerator({ byBand: bank });
    return [subject, (ctx: GenContext) => [...base(ctx), ...fromBank(ctx)]];
  }),
);

export function hasGeneratorFor(subject: string): boolean {
  return subject in SUBJECT_GENERATORS;
}

// ── Question pools and allocation ───────────────────────────────────────────
//
// Every material in a (grade, subject) group draws from ONE shared, fixed pool.
// Questions are then dealt out across the group's materials so that:
//   1. a material always gets the same questions (nothing depends on the clock),
//   2. topical materials get questions tagged with their own topics first, and
//   3. among equally relevant questions, the least-used ones are picked, so
//      materials in the same subject overlap as little as the pool allows.

/** Upper bound on pool size per group (procedural subjects can make thousands). */
const MAX_POOL = 900;
const MAX_POOL_PASSES = 30;

const poolCache = new Map<string, Question[]>();
const allocationCache = new Map<string, Map<string, number[]>>();

function groupKey(m: Pick<Material, "gradeKey" | "subject">): string {
  return `${m.gradeKey}|${m.subject}`;
}

/** The fixed, de-duplicated question pool for a material's (grade, subject) group. */
export function questionPool(material: Pick<Material, "gradeKey" | "subject">): Question[] {
  const key = groupKey(material);
  const cached = poolCache.get(key);
  if (cached) return cached;

  const gen = SUBJECT_GENERATORS[material.subject];
  const pool: Question[] = [];
  if (gen) {
    const resolved = resolveGrade(material.gradeKey);
    const seed = hashString(key);
    const seen = new Set<string>();
    for (let pass = 0; pass < MAX_POOL_PASSES && pool.length < MAX_POOL; pass++) {
      const before = pool.length;
      const ctx: GenContext = {
        subject: material.subject,
        gradeKey: material.gradeKey,
        grade: resolved.grade,
        band: resolved.band,
        topics: [],
        rng: makeRng(seed + pass * 7919),
      };
      for (const q of gen(ctx)) {
        const k = questionKey(q);
        if (seen.has(k)) continue;
        seen.add(k);
        pool.push(q);
        if (pool.length >= MAX_POOL) break;
      }
      // Fact banks are exhausted after one pass; procedural generators keep
      // yielding new items. Stop once a pass adds almost nothing new.
      if (pass > 0 && pool.length - before < 3) break;
    }
  }
  poolCache.set(key, pool);
  return pool;
}

function isOnTopic(material: Material, q: Question): boolean {
  // Exams cover the whole syllabus, so every question counts as relevant.
  if (material.type === "exam") return true;
  return matchesTopics(q.topics, material.topics);
}

/** Rank pool indexes for one material. Lower sort key = picked first. */
function rankFor(material: Material, pool: Question[], tiebreakSalt: string, penalty: (i: number) => number): number[] {
  const scored = pool.map((q, i) => ({
    i,
    onTopic: isOnTopic(material, q) ? 0 : 1,
    penalty: penalty(i),
    tie: hashString(`${material.id}|${tiebreakSalt}|${i}`),
  }));
  scored.sort((a, b) => a.onTopic - b.onTopic || a.penalty - b.penalty || a.tie - b.tie);
  return scored.map((s) => s.i);
}

/** Deal the group's pool out across its materials (deterministic, cached). */
function groupAllocation(material: Material, count: number): Map<string, number[]> {
  const key = `${groupKey(material)}|${count}`;
  const cached = allocationCache.get(key);
  if (cached) return cached;

  const pool = questionPool(material);
  const members = MATERIALS.filter((m) => groupKey(m) === groupKey(material));
  if (!members.some((m) => m.id === material.id)) members.push(material);

  const usage = new Array<number>(pool.length).fill(0);
  const allocation = new Map<string, number[]>();
  for (const m of members) {
    const picked = rankFor(m, pool, "base", (i) => usage[i]).slice(0, count);
    picked.forEach((i) => usage[i]++);
    allocation.set(m.id, picked);
  }
  allocationCache.set(key, allocation);
  return allocation;
}

function finalise(material: Material, pool: Question[], indexes: number[], attempt: number): Question[] {
  const rng = makeRng(hashString(`${material.id}|order|${attempt}`));
  return shuffle(rng, indexes).map((i) => {
    const { topics: _topics, ...q } = shuffleOptions(rng, pool[i]);
    return q;
  });
}

/**
 * The questions for a material.
 *
 * - `attempt` 0 (the default) is the material's fixed set: identical every time
 *   it is opened, on every device, as long as the content doesn't change.
 * - `attempt` N > 0 is an alternative set for "try a new question set": still
 *   on-topic first, but avoiding the questions of the fixed set where possible.
 *   Each N is itself stable, so a resumed retake keeps its questions.
 */
export function generateQuiz(material: Material, count: number, attempt = 0): Question[] {
  const want = Math.max(1, Math.floor(count));
  const pool = questionPool(material);
  if (pool.length === 0) return [];

  const base = groupAllocation(material, want).get(material.id) ?? [];
  if (attempt <= 0) return finalise(material, pool, base, 0);

  const inBase = new Set(base);
  const picked = rankFor(material, pool, `attempt-${attempt}`, (i) => (inBase.has(i) ? 1 : 0)).slice(0, want);
  return finalise(material, pool, picked, attempt);
}
