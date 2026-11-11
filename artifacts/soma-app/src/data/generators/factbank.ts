import type { GradeBand } from "@/data/grade";
import type { GenContext, Question, SubjectGenerator } from "./types";
import { buildMCQ, shuffle } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fact-bank generator — the workhorse for knowledge subjects (sciences,
// humanities, practical subjects, arts). Content is authored as grade-tiered
// pools of facts; distractors are drawn from sibling facts so every quiz is
// assembled fresh with shuffled options and (optionally) topic-biased picks.
// ─────────────────────────────────────────────────────────────────────────────

export interface Fact {
  /** Question stem. */
  q: string;
  /** Correct answer. */
  a: string;
  /** Extra plausible wrong answers specific to this fact (optional). */
  wrong?: string[];
  /** Topic tags — matched loosely against the material's topics to bias picks. */
  topics?: string[];
  /** Optional richer reason shown after answering; defaults to a restatement. */
  why?: string;
}

/** Turn a fact into a study statement, e.g. "The capital of Kenya is Nairobi." */
export function factStatement(f: Fact): string {
  const q = f.q.trim();
  const a = f.a.trim();
  if (q.endsWith(":")) return `${q.slice(0, -1).trim()} ${a}.`;
  if (q.endsWith("?")) return `${q} ${a.charAt(0).toUpperCase()}${a.slice(1)}.`;
  return `${q} — ${a}.`;
}

export interface FactBankConfig {
  /** Facts that only apply to an exact grade (1–12). */
  byGrade?: Partial<Record<number, Fact[]>>;
  /** Facts shared across a whole band. */
  byBand?: Partial<Record<GradeBand, Fact[]>>;
  /** Always-available facts regardless of grade. */
  common?: Fact[];
}

function normTopic(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when any of a question's topic tags loosely matches the material's topics. */
export function matchesTopics(tags: string[] | undefined, topics: string[]): boolean {
  if (!tags || tags.length === 0) return false;
  const wanted = topics.map(normTopic);
  return tags.some((ft) => {
    const f = normTopic(ft);
    return wanted.some((w) => w.includes(f) || f.includes(w) || w.split(" ").some((word) => word.length > 3 && f.includes(word)));
  });
}

export function resolveFacts(cfg: FactBankConfig, sel: { grade: number; band: GradeBand }): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  const add = (facts?: Fact[]) => {
    for (const f of facts ?? []) {
      const key = f.q.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  };
  add(cfg.byGrade?.[sel.grade]);
  add(cfg.byBand?.[sel.band]);
  add(cfg.common);
  return out;
}

export function makeFactBankGenerator(cfg: FactBankConfig): SubjectGenerator {
  return (ctx: GenContext): Question[] => {
    const all = resolveFacts(cfg, ctx);
    if (all.length === 0) return [];

    const answerPool = Array.from(new Set(all.map((f) => f.a)));
    const topicBiased = all.filter((f) => matchesTopics(f.topics, ctx.topics));
    // Lead with topic-relevant facts, then everything else for depth.
    const ordered = [...shuffle(ctx.rng, topicBiased), ...shuffle(ctx.rng, all.filter((f) => !topicBiased.includes(f)))];

    const out: Question[] = [];
    for (const fact of ordered) {
      const own = (fact.wrong ?? []).filter((w) => w && w !== fact.a);
      // Prefer the fact's own distractors; only borrow sibling answers to top up.
      const distractors = own.length >= 3
        ? own
        : [...own, ...shuffle(ctx.rng, answerPool.filter((a) => a !== fact.a && !own.includes(a)))];
      const q = buildMCQ(ctx.rng, fact.q, fact.a, distractors, fact.why ?? factStatement(fact));
      if (q) out.push(fact.topics?.length ? { ...q, topics: fact.topics } : q);
    }
    return out;
  };
}
