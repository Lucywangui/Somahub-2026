import { describe, expect, it } from "vitest";
import { MATERIALS, type Material } from "@/data/materials";
import { resolveGrade } from "@/data/grade";
import { generateQuiz, questionPool } from "@/data/generators";
import { matchesTopics } from "@/data/generators/factbank";
import { contentFactsForSubject } from "@/data/generators/contentFacts";
import { QUESTION_BANKS } from "@/data/generators/banks";
import { subjectBands, validateBank } from "@/data/generators/bankValidation";
import type { GradeBand } from "@/data/grade";

const COUNT = 15;
/** Each group needs at least this many distinct questions (30 materials × 15 = 450 slots). */
const MIN_POOL = 120;

const groups = new Map<string, Material[]>();
for (const m of MATERIALS) {
  const k = `${m.gradeKey}|${m.subject}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(m);
}

const sample = (subject: string, gradeKey: string, type: Material["type"] = "topical") =>
  MATERIALS.find((m) => m.subject === subject && m.gradeKey === gradeKey && m.type === type)!;

describe("generateQuiz", () => {
  it("returns the same questions every time a material is opened", () => {
    for (const m of [sample("Biology", "senior-11"), sample("Hygiene and Nutrition", "cbc-1"), sample("Mathematics", "cbc-5")]) {
      const a = generateQuiz(m, COUNT);
      const b = generateQuiz({ ...m }, COUNT);
      expect(b).toEqual(a);
    }
  });

  it("returns 15 distinct, well-formed questions", () => {
    for (const ms of groups.values()) {
      const qs = generateQuiz(ms[0], COUNT);
      expect(qs).toHaveLength(COUNT);
      expect(new Set(qs.map((q) => q.text)).size).toBe(COUNT);
      for (const q of qs) {
        expect(q.options).toHaveLength(4);
        expect(new Set(q.options).size).toBe(4);
        expect(q.correct).toBeGreaterThanOrEqual(0);
        expect(q.correct).toBeLessThan(4);
      }
    }
  });

  it("gives a mostly different set when a new question set is requested", () => {
    // An exam covers the whole syllabus, so there is plenty of room for a fresh set.
    // (A single-topic quiz stays on its topic first, so it can only change as much
    // as that topic's question supply allows.)
    const m = sample("Geography", "senior-10", "exam");
    const base = new Set(generateQuiz(m, COUNT, 0).map((q) => q.text));
    const next = generateQuiz(m, COUNT, 1);
    const overlap = next.filter((q) => base.has(q.text)).length;
    expect(overlap).toBeLessThanOrEqual(5);
    expect(generateQuiz(m, COUNT, 1)).toEqual(next); // a given set is itself stable
  });

  it("keeps single-topic quizzes on their topic", () => {
    for (const ms of groups.values()) {
      if (ms[0].subject === "Mathematics") continue; // procedural, not topic-tagged
      const m = ms.find((x) => x.type === "topical" && x.topics.length === 1)!;
      const pool = questionPool(m);
      const available = pool.filter((q) => matchesTopics(q.topics, m.topics)).length;
      const onTopic = generateQuiz(m, COUNT).filter((q) => {
        const src = pool.find((p) => p.text === q.text);
        return matchesTopics(src?.topics, m.topics);
      }).length;
      expect(onTopic, `${m.id}`).toBe(Math.min(COUNT, available));
    }
  });
});

describe("question supply (guards against materials repeating each other)", () => {
  for (const [key, ms] of groups) {
    it(`${key} has enough distinct questions for its ${ms.length} materials`, () => {
      const pool = questionPool(ms[0]);
      expect(pool.length).toBeGreaterThanOrEqual(MIN_POOL);

      // No single question should appear in more materials than the pool forces.
      const uses = new Map<string, number>();
      for (const m of ms) for (const q of generateQuiz(m, COUNT)) uses.set(q.text, (uses.get(q.text) ?? 0) + 1);
      const fairShare = Math.ceil((ms.length * COUNT) / pool.length);
      const worst = Math.max(...uses.values());
      expect(worst).toBeLessThanOrEqual(fairShare + 4);
    });
  }
});

describe("authored question banks", () => {
  for (const { subject, band } of subjectBands()) {
    if (subject === "Mathematics") continue;
    it(`${subject} / ${band} is valid and covers every topic`, () => {
      const facts = QUESTION_BANKS[subject]?.[band as GradeBand] ?? [];
      const existing = MATERIALS.filter((m) => m.subject === subject && resolveGrade(m.gradeKey).band === band).flatMap((m) => {
        const g = resolveGrade(m.gradeKey);
        return contentFactsForSubject(subject, g.grade, g.band);
      });
      const unique = [...new Map(existing.map((f) => [f.q.trim().toLowerCase(), f])).values()];
      expect(validateBank(subject, band as GradeBand, facts, unique)).toEqual([]);
    });
  }
});
