/**
 * check-question-bank — validate one authored question bank file.
 *
 *   npx vite-node scripts/check-question-bank.mts "<Subject>" <band>
 *   npx vite-node scripts/check-question-bank.mts --topics "<Subject>" <band>   # list topic names
 *
 * Imports only the target bank file (not the whole registry) so a half-written
 * sibling bank cannot break the check.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { GradeBand } from "../src/data/grade.ts";
import { resolveGrade } from "../src/data/grade.ts";
import { MATERIALS } from "../src/data/materials.ts";
import { contentFactsForSubject } from "../src/data/generators/contentFacts.ts";
import { FACTS_PER_TOPIC, topicsFor, validateBank } from "../src/data/generators/bankValidation.ts";

const args = process.argv.slice(2);
const listTopics = args[0] === "--topics";
if (listTopics) args.shift();
const [subject, band] = args as [string, GradeBand];
if (!subject || !band) {
  console.error('usage: check-question-bank.mts [--topics] "<Subject>" <band>');
  process.exit(2);
}

const topics = topicsFor(subject, band);
if (!topics.length) {
  console.error(`No catalogue materials for ${subject} in band ${band}.`);
  process.exit(2);
}
if (listTopics) {
  console.log(topics.join("\n"));
  process.exit(0);
}

const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const file = resolve(import.meta.dirname ?? ".", `../src/data/generators/banks/${slug}/${band}.ts`);
const { FACTS } = await import(pathToFileURL(file).href);

// Existing (older) questions for every grade in this band — new ones must not duplicate them.
const existing = new Map<string, ReturnType<typeof contentFactsForSubject>[number]>();
for (const m of MATERIALS) {
  const g = resolveGrade(m.gradeKey);
  if (m.subject !== subject || g.band !== band) continue;
  for (const f of contentFactsForSubject(subject, g.grade, band)) existing.set(f.q.trim().toLowerCase(), f);
}

const problems = validateBank(subject, band, FACTS, [...existing.values()]);
console.log(`${subject} / ${band}: ${FACTS.length} questions (target ≈ ${topics.length * FACTS_PER_TOPIC}), ${problems.length} problem(s)`);
for (const p of problems.slice(0, 80)) console.log("  - " + p);
if (problems.length > 80) console.log(`  … and ${problems.length - 80} more`);
process.exit(problems.length ? 1 : 0);
