import type { GradeBand } from "@/data/grade";
import { resolveGrade } from "@/data/grade";
import { MATERIALS } from "@/data/materials";
import type { Fact } from "./factbank";

/** New questions to author per syllabus topic, per subject-band. */
export const FACTS_PER_TOPIC = 15;
/** Hard floor enforced by validation (gives authors a little slack). */
export const MIN_FACTS_PER_TOPIC = 12;

const BANNED_OPTIONS = /^(all|none|both|neither) of the (above|these)$|^all of them$|^none of them$/i;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Every topic name the catalogue attaches to materials for a subject in a band. */
export function topicsFor(subject: string, band: GradeBand): string[] {
  const out = new Set<string>();
  for (const m of MATERIALS) {
    if (m.subject === subject && resolveGrade(m.gradeKey).band === band) m.topics.forEach((t) => out.add(t));
  }
  return [...out];
}

/** All (subject, band) pairs that appear in the catalogue. */
export function subjectBands(): { subject: string; band: GradeBand }[] {
  const seen = new Map<string, { subject: string; band: GradeBand }>();
  for (const m of MATERIALS) {
    const band = resolveGrade(m.gradeKey).band;
    seen.set(`${m.subject}|${band}`, { subject: m.subject, band });
  }
  return [...seen.values()];
}

/**
 * Structural checks for an authored bank. Returns human-readable problems;
 * an empty array means the bank is valid. `existing` are questions already in
 * the older content files for the same subject-band (duplicates are rejected).
 */
export function validateBank(
  subject: string,
  band: GradeBand,
  facts: Fact[],
  existing: Fact[] = [],
  opts: { requireCoverage?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const allowed = new Set(topicsFor(subject, band));
  const seenQ = new Set(existing.map((f) => norm(f.q)));
  const perTopic = new Map<string, number>();

  facts.forEach((f, i) => {
    const where = `#${i + 1} "${(f.q ?? "").slice(0, 60)}"`;
    if (!f.q?.trim()) problems.push(`${where}: empty question`);
    if (!f.a?.trim()) problems.push(`${where}: empty answer`);
    if (!f.why?.trim()) problems.push(`${where}: missing "why" explanation`);
    const wrong = f.wrong ?? [];
    if (wrong.length < 3) problems.push(`${where}: needs at least 3 wrong options (has ${wrong.length})`);
    const opts = [f.a, ...wrong].map((o) => norm(o ?? ""));
    if (new Set(opts).size !== opts.length) problems.push(`${where}: options are not all distinct`);
    if (opts.some((o) => !o)) problems.push(`${where}: an option is empty`);
    if ([f.a, ...wrong].some((o) => BANNED_OPTIONS.test((o ?? "").trim()))) problems.push(`${where}: uses "all/none of the above"-style option`);
    if (!f.topics?.length) problems.push(`${where}: no topics`);
    for (const t of f.topics ?? []) {
      if (!allowed.has(t)) problems.push(`${where}: unknown topic "${t}" (must be one of the catalogue topics)`);
      else perTopic.set(t, (perTopic.get(t) ?? 0) + 1);
    }
    const key = norm(f.q ?? "");
    if (seenQ.has(key)) problems.push(`${where}: duplicate question`);
    seenQ.add(key);
  });

  if (opts.requireCoverage !== false) {
    for (const t of allowed) {
      const n = perTopic.get(t) ?? 0;
      if (n < MIN_FACTS_PER_TOPIC) problems.push(`topic "${t}": only ${n} questions (need ≥ ${MIN_FACTS_PER_TOPIC})`);
    }
  }
  return problems;
}
