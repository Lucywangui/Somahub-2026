import type { GradeBand } from "@/data/grade";
import type { Fact } from "./factbank";
import { QUESTION_BANKS } from "./banks";
import { contentFactsForSubject } from "./contentFacts";

export { SUBJECT_FACTS, contentFactsForSubject } from "./contentFacts";

/** Every fact for a subject at a grade: original content plus the authored question bank. */
export function factsForSubject(subject: string, grade: number, band: GradeBand): Fact[] {
  const base = contentFactsForSubject(subject, grade, band);
  const seen = new Set(base.map((f) => f.q.trim().toLowerCase()));
  const extra = (QUESTION_BANKS[subject]?.[band] ?? []).filter((f) => !seen.has(f.q.trim().toLowerCase()));
  return [...base, ...extra];
}
