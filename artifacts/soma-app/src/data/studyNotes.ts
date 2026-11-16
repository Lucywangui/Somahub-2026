import type { Material } from "./materials";
import { resolveGrade, type GradeBand } from "./grade";
import { practiceQuestions } from "./generators";
import { factsForSubject } from "./generators/factIndex";
import type { GeneratedNote, NoteBlock, NoteSource, NoteSubtopic } from "./notesTypes";

// The generated notes module is ~2 MB, so it is code-split into its own chunk
// and only pulled in the first time a learner opens study notes.
let generatedCache: Record<string, GeneratedNote> | null = null;
async function loadGeneratedNotes(): Promise<Record<string, GeneratedNote>> {
  if (!generatedCache) {
    generatedCache = (await import("./notes.generated")).GENERATED_NOTES;
  }
  return generatedCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Study notes — curriculum-aligned revision material for a bought material.
// Content comes from three layers, best first:
//   1. GENERATED_NOTES  — built offline from open sources (Wikipedia, Wikibooks,
//      …) by scripts/build-study-notes.mts. Extensive prose, with attribution.
//   2. TOPIC_NOTES       — hand-authored notes below (crisp key points, examples).
//   3. a structured study-guide fallback.
// Each set is framed for the learner's grade band and ends with worked revision
// questions taken from the same generator that builds the quiz.
// ─────────────────────────────────────────────────────────────────────────────

export type { NoteBlock, NoteSource, NoteSubtopic } from "./notesTypes";

export interface TopicNote {
  name: string;
  /** 1–3 paragraphs defining the topic. */
  overview: string[];
  /** Crisp bullet takeaways from the hand-authored layer, when available. */
  keyPoints: string[];
  /** Navigable drill-down sections. */
  subtopics: NoteSubtopic[];
  sources: NoteSource[];
}

export interface StudyNote {
  title: string;
  subject: string;
  gradeLabel: string;
  intro: string;
  topics: TopicNote[];
  practice: { q: string; a: string }[];
  /** De-duplicated sources across all topics, for the attribution footer. */
  sources: NoteSource[];
}

/** Plain, learner-facing name for a band. */
function gradeWord(band: GradeBand): string {
  return band === "lower" ? "the early grades"
    : band === "upper" ? "upper primary"
    : band === "junior" ? "junior school"
    : "senior school";
}

// How to approach each subject, by band. Keeps the notes grounded even where a
// topic has no dedicated entry below.
const SUBJECT_GUIDANCE: Record<string, Partial<Record<GradeBand, string>>> = {
  Mathematics: {
    lower: "Work with real objects — bottle tops, stones, fingers — before writing numbers. Say each step aloud and check by counting back.",
    upper: "Show every working step. Estimate the answer first, then compare it with what you calculate. Learn your times tables to 12 by heart.",
    junior: "Set out each solution line by line. Substitute your answer back into the original equation to check it. Keep a list of formulae you keep forgetting.",
    senior: "Practise past-paper questions under time. Know the standard forms (quadratic, trig identities, differentiation rules) so you spend thinking time on the method, not recall.",
  },
  English: {
    lower: "Read a little aloud every day. Point at each word as you say it, and sound out new words letter by letter.",
    upper: "When you read a passage, find the topic sentence of each paragraph. Keep a vocabulary book of new words with an example sentence.",
    junior: "Plan before you write: jot the main points, order them, then draft. Re-read your work once for meaning and once for punctuation.",
    senior: "Support every point about a text with a short quotation and a comment on effect. Learn the literary terms so you can name techniques quickly.",
  },
  Kiswahili: {
    lower: "Soma kwa sauti kila siku. Tamka kila silabi taratibu na uunganishe silabi kuunda maneno.",
    upper: "Jenga msamiati kwa kuandika maneno mapya na sentensi za mfano. Zingatia upatanisho wa ngeli katika sentensi.",
    junior: "Panga hoja kabla ya kuandika insha. Kagua kazi yako mara mbili — kwa maana kwanza, kisha kwa alama za uandishi.",
    senior: "Thibitisha kila hoja kuhusu kazi ya fasihi kwa mfano kutoka kwenye kazi husika. Jifunze istilahi za fasihi ili uzitumie haraka.",
  },
};

// Curated topic notes. Keyed by "Subject :: Topic" and by "Topic" alone as a
// fallback so a topic shared across grades still matches.
const TOPIC_NOTES: Record<string, NoteBlock[]> = {
  "Mathematics :: Addition": [
    { heading: "What it means", paragraphs: ["Addition combines two or more amounts to find the total, or 'sum'. The order does not matter: 3 + 5 gives the same answer as 5 + 3."] },
    { heading: "Key points", paragraphs: [], points: ["Line up ones under ones and tens under tens.", "Add the ones first; if you get 10 or more, carry a ten to the next column.", "Adding 0 to a number leaves it unchanged.", "Check by adding the numbers in a different order."] },
  ],
  "Mathematics :: Subtraction": [
    { heading: "What it means", paragraphs: ["Subtraction takes one amount away from another to find the difference, or how many are left. Unlike addition, the order does matter."] },
    { heading: "Key points", paragraphs: [], points: ["Line up the digits by place value.", "If the top digit is smaller, borrow one from the next column.", "Check by adding your answer to the number you subtracted — you should get back the start number."] },
  ],
  "Mathematics :: Fractions (½ & ¼)": [
    { heading: "What it means", paragraphs: ["A fraction shows equal parts of a whole. The bottom number (denominator) is how many equal parts there are; the top number (numerator) is how many you have. ½ means one of two equal parts."] },
    { heading: "Key points", paragraphs: [], points: ["Two halves make one whole; four quarters make one whole.", "½ is bigger than ¼.", "Fractions that name the same amount (like ½ and 2/4) are equivalent."] },
  ],
  "Mathematics :: Percentages": [
    { heading: "What it means", paragraphs: ["'Per cent' means 'out of 100'. 25% means 25 out of every 100, which is the same as the fraction 25/100 or the decimal 0.25."] },
    { heading: "Finding a percentage of a number", paragraphs: [], points: ["10% of a number: divide by 10.", "50%: divide by 2. 25%: divide by 4.", "For other percentages, find 1% (divide by 100) then multiply."] },
  ],
  "Mathematics :: Algebra": [
    { heading: "What it means", paragraphs: ["Algebra uses letters to stand for unknown numbers. An equation says two expressions are equal; solving it means finding the value of the letter that makes the statement true."] },
    { heading: "Solving a linear equation", paragraphs: [], points: ["Do the same operation to both sides to keep it balanced.", "Undo addition/subtraction first, then multiplication/division.", "Substitute your answer back to check."] },
  ],
  "English :: Nouns & Verbs": [
    { heading: "Nouns", paragraphs: ["A noun names a person, place, animal, thing or idea (teacher, Nairobi, dog, table, honesty). A proper noun names something specific and always starts with a capital letter."] },
    { heading: "Verbs", paragraphs: ["A verb shows an action (run, write) or a state of being (is, seems). Every complete sentence needs a verb. The verb changes to show the tense — when the action happens."] },
  ],
  "English :: Vocabulary & Idioms": [
    { heading: "Building vocabulary", paragraphs: ["Learn words in context, not as lists. A synonym means the same (big / large); an antonym means the opposite (big / small)."] },
    { heading: "Idioms", paragraphs: ["An idiom is a phrase whose meaning is different from the literal words, e.g. 'break the ice' means to start a friendly conversation. Idioms must be learned as whole phrases."] },
  ],
  "English :: Reading Comprehension": [
    { heading: "How to read a passage", paragraphs: ["Read once quickly for the general idea, then again slowly. The main idea of a paragraph is usually in its topic sentence."] },
    { heading: "Answering questions", paragraphs: [], points: ["Underline key words in the question.", "Find the part of the text the question points to.", "Answer in your own words unless asked to quote.", "For 'infer' questions, use clues in the text plus reasoning."] },
  ],
  "Integrated Science :: Cells": [
    { heading: "The cell", paragraphs: ["All living things are made of cells — the smallest unit that can carry out life processes. Animal and plant cells both have a cell membrane, cytoplasm and a nucleus that controls activities."] },
    { heading: "Plant cells only", paragraphs: [], points: ["Cell wall — gives shape and support.", "Chloroplasts — trap light for photosynthesis.", "A large permanent vacuole — stores cell sap."] },
  ],
  "Integrated Science :: Matter": [
    { heading: "States of matter", paragraphs: ["Matter exists as solid (fixed shape and volume), liquid (fixed volume, takes the shape of its container) or gas (fills its container). Heating adds energy and moves matter toward gas; cooling reverses this."] },
    { heading: "Separating mixtures", paragraphs: [], points: ["Filtration — separates an insoluble solid from a liquid.", "Evaporation — recovers a dissolved solid from its solution.", "Distillation — separates a liquid from a solution by boiling and condensing."] },
  ],
  "Biology :: Cell Structure & Organisation": [
    { heading: "Organelles", paragraphs: ["The nucleus stores DNA and controls the cell. Mitochondria release energy in aerobic respiration. Ribosomes build proteins. In plant cells, chloroplasts carry out photosynthesis and the cell wall gives support."] },
    { heading: "Levels of organisation", paragraphs: ["cells → tissues → organs → organ systems → organism. Each level is a group of the level below working together for a shared function."] },
  ],
  "Chemistry :: Structure of the Atom": [
    { heading: "Sub-atomic particles", paragraphs: ["An atom has protons (positive) and neutrons (neutral) in the nucleus, with electrons (negative) in shells around it. The atomic number is the number of protons; the mass number is protons + neutrons."] },
    { heading: "Isotopes", paragraphs: ["Isotopes are atoms of the same element (same protons) with different numbers of neutrons, so different mass numbers. They have the same chemical properties."] },
  ],
  "Physics :: Mechanics: Statics & Dynamics": [
    { heading: "Key quantities", paragraphs: ["Force is measured in newtons (N). Work done = force × distance moved in the direction of the force, measured in joules (J). Power is the rate of doing work, in watts (W)."] },
    { heading: "Newton's second law", paragraphs: ["Force = mass × acceleration (F = ma). A resultant force changes an object's motion; with no resultant force, velocity stays constant."] },
  ],
  "Social Studies :: Government & Citizenship": [
    { heading: "Being a citizen", paragraphs: ["A citizen has both rights (education, life, expression) and duties (obey the law, pay taxes, vote, protect public property). Rights and duties go together."] },
    { heading: "How Kenya is governed", paragraphs: ["Power is shared between the national government and 47 county governments (devolution). The three arms are the Executive, the Legislature (Parliament) and the Judiciary."] },
  ],
  "History and Citizenship :: Kenyan Independence Movement": [
    { heading: "The road to independence", paragraphs: ["African grievances over land and political exclusion grew into organised nationalism. The Mau Mau uprising (1950s) increased pressure on the colonial government. The Lancaster House Conferences prepared a new constitution, and Kenya gained internal self-government in 1963."] },
  ],
  "Geography :: Internal Land-Forming Processes": [
    { heading: "Internal (endogenetic) processes", paragraphs: ["These act from inside the earth: tectonic movements (faulting and folding), vulcanicity and earthquakes. Faulting formed Kenya's Great Rift Valley; folding produces fold mountains."] },
  ],
  "Business Studies :: Accounting Basics": [
    { heading: "The accounting equation", paragraphs: ["Assets = Capital + Liabilities. Every transaction is recorded in at least two accounts (double entry), keeping the equation balanced."] },
    { heading: "Profit", paragraphs: ["Gross profit = sales − cost of goods sold. Net profit = gross profit − expenses such as rent and salaries."] },
  ],
  "Literature :: Literary Devices": [
    { heading: "Common devices", paragraphs: [], points: ["Simile — comparison using 'like' or 'as'.", "Metaphor — a direct comparison, no 'like'/'as'.", "Personification — human qualities given to non-human things.", "Imagery — language that appeals to the senses.", "Irony — a gap between what is said/expected and what is meant/happens."] },
  ],
  "Hygiene and Nutrition :: Personal Hygiene": [
    { heading: "Keeping clean and healthy", paragraphs: [], points: ["Wash hands with soap before eating and after the toilet.", "Brush teeth at least twice a day.", "Bathe daily and wear clean clothes.", "Keep fingernails short and clean."] },
  ],
  "Christian Religious Education :: Honesty & Truth": [
    { heading: "Why honesty matters", paragraphs: ["Honesty means telling the truth and not taking what is not yours. It builds trust between people and reflects respect for God and others. Dishonesty breaks relationships and community."] },
  ],
  "Creative Arts :: Drawing & Painting": [
    { heading: "Colour", paragraphs: ["The primary colours are red, blue and yellow. Mixing two primaries makes a secondary colour (green, orange, purple). Adding white makes a tint; adding black makes a shade."] },
  ],
  "Mathematics :: Multiplication": [
    { heading: "What it means", paragraphs: ["Multiplication is repeated addition: 4 × 3 means four groups of three, or 3 + 3 + 3 + 3 = 12. The answer is called the product, and the order does not matter."] },
    { heading: "Key points", paragraphs: [], points: ["Learn the times tables to 12 by heart.", "Multiplying by 10 adds a zero; by 100 adds two zeros.", "Break big multiplications into parts: 7 × 13 = 7 × 10 + 7 × 3."] },
  ],
  "Mathematics :: Geometry": [
    { heading: "Shapes and angles", paragraphs: ["A right angle is 90°; angles less than that are acute, more than that (up to 180°) are obtuse. Angles on a straight line add up to 180°, and angles round a point add up to 360°."] },
    { heading: "Common shapes", paragraphs: [], points: ["Triangle — 3 sides, angles add to 180°.", "Quadrilateral — 4 sides, angles add to 360°.", "A polygon is regular when all sides and angles are equal."] },
  ],
  "Mathematics :: Area & Perimeter": [
    { heading: "Perimeter", paragraphs: ["Perimeter is the total distance around the outside of a shape. For a rectangle it is 2 × (length + width); just add all the side lengths for any other shape."] },
    { heading: "Area", paragraphs: ["Area is the amount of surface a shape covers, measured in square units. Rectangle: length × width. Triangle: ½ × base × height."] },
  ],
  "Mathematics :: Trigonometry": [
    { heading: "The ratios", paragraphs: ["In a right-angled triangle: sin θ = opposite / hypotenuse, cos θ = adjacent / hypotenuse, tan θ = opposite / adjacent. Remember them as SOH-CAH-TOA."] },
    { heading: "Key values", paragraphs: [], points: ["sin 0° = 0, sin 30° = 0.5, sin 90° = 1.", "cos 0° = 1, cos 60° = 0.5, cos 90° = 0.", "tan 45° = 1."] },
  ],
  "Mathematics :: Statistics & Probability": [
    { heading: "Averages", paragraphs: ["Mean = sum of values ÷ number of values. Median = middle value when data is ordered. Mode = the value that appears most often."] },
    { heading: "Probability", paragraphs: ["Probability of an event = favourable outcomes ÷ total outcomes, a value from 0 (impossible) to 1 (certain). The probabilities of all possible outcomes add up to 1."] },
  ],
  "English :: Grammar": [
    { heading: "Parts of speech", paragraphs: ["The eight parts of speech are noun, pronoun, verb, adjective, adverb, preposition, conjunction and interjection. Knowing a word's job in the sentence tells you which one it is."] },
    { heading: "Agreement and tense", paragraphs: [], points: ["The verb must agree with the subject in number.", "Keep tense consistent within a piece of writing.", "Use commas to separate items in a list and to mark off extra information."] },
  ],
  "English :: Essay Writing": [
    { heading: "Structure", paragraphs: ["An essay has an introduction (states the topic and your stand), body paragraphs (one main idea each, with evidence), and a conclusion (sums up, no new points)."] },
    { heading: "Before you write", paragraphs: [], points: ["Brainstorm points, then group and order them.", "Write a topic sentence for each paragraph first.", "Leave time to re-read once for sense and once for grammar."] },
  ],
  "Biology :: Genetics": [
    { heading: "Basic terms", paragraphs: ["A gene is a section of DNA that codes for a trait. Alleles are versions of a gene. An organism is homozygous when its two alleles match and heterozygous when they differ; dominant alleles mask recessive ones."] },
    { heading: "Monohybrid cross", paragraphs: ["Crossing two heterozygotes (Aa × Aa) gives offspring in the ratio 3 dominant : 1 recessive. Use a Punnett square to work out the combinations."] },
  ],
  "Physics :: Electricity": [
    { heading: "Current, voltage, resistance", paragraphs: ["Current (amperes) is the flow of charge. Voltage (volts) is the energy given to that charge. Resistance (ohms) opposes the flow. Ohm's law: V = I × R."] },
    { heading: "Circuits", paragraphs: [], points: ["Series: one path — current is the same everywhere, voltages add up.", "Parallel: branches — voltage is the same across each, currents add up.", "A circuit must be complete for current to flow."] },
  ],
  "Chemistry :: Acids, Bases & Salts": [
    { heading: "The pH scale", paragraphs: ["pH runs from 0 to 14. Below 7 is acidic, 7 is neutral, above 7 is basic (alkaline). Indicators such as litmus show whether a solution is acidic or basic."] },
    { heading: "Reactions", paragraphs: [], points: ["Acid + base → salt + water (neutralisation).", "Acid + metal → salt + hydrogen.", "Acid + carbonate → salt + water + carbon dioxide."] },
  ],
};

const STOP_WORDS = new Set(["the", "and", "of", "in", "a", "to", "for", "with", "our", "an", "on", "at", "ya", "wa", "na"]);

function meaningfulWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function stemMatch(a: string, b: string): boolean {
  return a === b || a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5));
}

/**
 * Curated note for a topic — exact "Subject :: Topic" key, else an exact-topic
 * match under any subject, else a SAME-SUBJECT word-overlap match. Never matches
 * across subjects on loose word overlap (that produced wrong-topic notes).
 */
function curatedBlocks(subject: string, topic: string): NoteBlock[] | undefined {
  const exact = TOPIC_NOTES[`${subject} :: ${topic}`] ||
    Object.entries(TOPIC_NOTES).find(([k]) => k.endsWith(` :: ${topic}`))?.[1];
  if (exact) return exact;

  const target = meaningfulWords(topic);
  if (target.length === 0) return undefined;
  let best: { score: number; blocks: NoteBlock[] } | undefined;
  for (const [key, blocks] of Object.entries(TOPIC_NOTES)) {
    const [kSubject, kTopic] = key.split(" :: ");
    if (kSubject !== subject) continue; // same subject only
    const score = meaningfulWords(kTopic).filter((w) => target.some((t) => stemMatch(w, t))).length;
    if (score > 0 && (!best || score > best.score)) best = { score, blocks };
  }
  return best?.blocks;
}

function authoredParts(blocks: NoteBlock[] | undefined): { overview: string[]; keyPoints: string[] } {
  const overview: string[] = [];
  const keyPoints: string[] = [];
  for (const b of blocks ?? []) {
    overview.push(...b.paragraphs);
    if (b.points) keyPoints.push(...b.points);
  }
  return { overview, keyPoints };
}

/** Turn a quiz-bank fact ("The X is:", "loam soil") into a study statement. */
function factToStatement(f: { q: string; a: string }): string {
  const q = f.q.trim();
  const a = f.a.trim();
  if (q.endsWith(":")) return `${q.slice(0, -1).trim()} ${a}.`;
  if (q.endsWith("?")) return `${q} ${a.charAt(0).toUpperCase()}${a.slice(1)}.`;
  return `${q} — ${a}.`;
}

/** Curriculum facts for a topic, as plain statements. Always available offline. */
function factStatements(subject: string, topic: string, grade: number, band: GradeBand): string[] {
  const all = factsForSubject(subject, grade, band);
  if (all.length === 0) return [];
  const target = meaningfulWords(topic);
  const matched = all.filter((f) =>
    (f.topics ?? []).some((tag) => {
      const tw = meaningfulWords(tag);
      return tw.some((w) => target.some((t) => stemMatch(w, t)));
    }),
  );
  const pool = matched.length >= 2 ? matched : all;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of pool) {
    const s = factToStatement(f);
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Best available note for a topic, layered:
 *   overview   — generated (open source) → authored paragraphs → one honest line
 *   keyPoints  — authored bullets + curriculum-fact statements (merged, deduped)
 *   subtopics  — generated drill-down sections (from the source article)
 */
// Drop Wikipedia hatnote / disambiguation lines that occasionally lead an extract.
const HATNOTE = /^(not to be confused|this article is about|for other uses|for the |"[^"]+" redirects here|see also:)/i;
function stripHatnotes(paras: string[]): string[] {
  const cleaned = paras.filter((p) => !HATNOTE.test(p.trim()));
  return cleaned.length ? cleaned : paras;
}

// ── Age-appropriate rewriting of fetched (encyclopedia-register) text ───────
// Rule-based only: shorten to a few sentences, drop over-long or heavily
// parenthetical ones, strip academic openers, and swap common hard words for
// plain ones in the younger bands. Nothing here invents facts.
const BAND_LIMITS: Record<GradeBand, { sentences: number; maxWords: number }> = {
  lower: { sentences: 2, maxWords: 18 },
  upper: { sentences: 3, maxWords: 24 },
  junior: { sentences: 4, maxWords: 26 },
  senior: { sentences: 6, maxWords: 40 },
};

// Sentences that are noise for a learner (etymology, article meta, off-topic).
const JUNK_SENTENCE = /\b(etymolog|diminutive|suffix\b|prefix\b|pronounced|plural of|singular of|the name\b.*\bcomes from|derived from (?:the )?(?:latin|greek|ancient greek)|from (?:the )?(?:latin|greek|ancient greek)\b|first performed|history of the (?:scientific|word)|is different from the history|involving slaves?|not to be confused|may refer to|\(disambiguation\)|redirects here)/i;
// Whole notes to reject — a disambiguation / list page slipped through.
const DISAMBIG = /===|\((?:19|20)\d{2} (?:film|album|song|band|novel|video game)\)|may refer to:|is a list of/i;

const PLAIN_WORDS: [RegExp, string][] = [
  [/\butilises?\b/gi, "uses"], [/\butilize[ds]?\b/gi, "use"], [/\butilization\b/gi, "use"],
  [/\bapproximately\b/gi, "about"], [/\bnumerous\b/gi, "many"],
  [/\bcomprises?\b/gi, "is made up of"], [/\bconsists? of\b/gi, "is made up of"],
  [/\bobtained\b/gi, "got"], [/\bobtains?\b/gi, "gets"],
  [/\bsufficient\b/gi, "enough"], [/\bcommence(d|s)?\b/gi, "start"],
  [/\bprior to\b/gi, "before"], [/\bin order to\b/gi, "to"],
  [/\badditional\b/gi, "extra"], [/\bassist(ed|s|ance)?\b/gi, "help"],
  [/\bdemonstrate(d|s)?\b/gi, "show"], [/\bpurchase(d|s)?\b/gi, "buy"],
  [/\bpermit(ted|s)?\b/gi, "let"], [/\brequire(d|s)?\b/gi, "need"],
  [/\bfundamental\b/gi, "basic"], [/\bsubsequently\b/gi, "later"],
  [/\btypically\b/gi, "usually"], [/\bfacilitate(s|d)?\b/gi, "help"],
  [/\benable(s|d)?\b/gi, "let"], [/\bregarding\b/gi, "about"],
  [/\bacquired\b/gi, "got"], [/\bacquires?\b/gi, "gets"], [/\bacquiring\b/gi, "getting"],
  [/\brigorous(ly)?\b/gi, "careful"], [/\bprimarily\b/gi, "mainly"],
  [/\bvarious\b/gi, "different"], [/\bsignificant(ly)?\b/gi, "important"],
  [/\bindividuals\b/gi, "people"], [/\boccurs?\b/gi, "happens"], [/\boccurred\b/gi, "happened"],
  [/\bconstitutes?\b/gi, "make up"], [/\bmethodolog(y|ies)\b/gi, "method"],
  [/\bentit(y|ies)\b/gi, "thing"], [/\bmodif(y|ies|ied)\b/gi, "change"],
];

function stripAcademicOpeners(s: string): string {
  return s
    .replace(/^In [A-Z][a-z]+(?:\s+and\s+[A-Z][a-z]+)?,\s+/, "")
    .replace(/^Generally,\s+/i, "")
    .replace(/^In general,\s+/i, "")
    .replace(/^Historically,\s+/i, "")
    // parentheses holding etymology / pronunciation / aliases
    .replace(/\s*\((?:from |also (?:called|known as)|pronounced|abbreviated|Ancient Greek|Latin|Greek|IPA|\/)[^)]*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean);
}

function tidy(s: string, band: GradeBand): string {
  s = stripAcademicOpeners(s);
  if (band !== "senior") for (const [re, rep] of PLAIN_WORDS) s = s.replace(re, rep);
  s = s.replace(/\s+([.,;:])/g, "$1").replace(/\.{2,}/g, ".").replace(/\s{2,}/g, " ").trim();
  if (!/[.!?]$/.test(s)) s += ".";
  return s;
}

function readable(paras: string[], band: GradeBand): string[] {
  const { sentences: maxS, maxWords } = BAND_LIMITS[band];
  const heavy = band === "lower" ? 2 : band === "upper" ? 3 : band === "junior" ? 4 : 6;
  const out: string[] = [];

  const allSentences = paras.flatMap((p) => splitSentences(p));
  if (allSentences.length === 0) return [];

  // Always try to keep the opening definition sentence, trimmed to fit.
  let lead = tidy(allSentences[0], band);
  if (!JUNK_SENTENCE.test(lead)) {
    const w = lead.split(/\s+/);
    if (w.length > maxWords + 6) lead = w.slice(0, maxWords).join(" ").replace(/[;,]+$/, "") + " …";
    out.push(lead);
  }

  for (const raw of allSentences.slice(1)) {
    if (out.length >= maxS) break;
    if (JUNK_SENTENCE.test(raw)) continue;
    const s = tidy(raw, band);
    const words = s.split(/\s+/).length;
    if (words < 4 || words > maxWords) continue;
    if ((s.match(/[;]/g)?.length ?? 0) > 0) continue;           // no semicolon clauses
    if ((s.match(/,/g)?.length ?? 0) > heavy) continue;         // not too clause-heavy
    if (!out.includes(s)) out.push(s);
  }

  if (out.length === 0) {
    const cand = [...allSentences].sort((a, b) => a.length - b.length)[0];
    out.push(tidy(cand.split(/\s+/).slice(0, maxWords).join(" "), band));
  }
  return out;
}

function topicContent(
  generatedNotes: Record<string, GeneratedNote>,
  subject: string, topic: string, band: GradeBand, grade: number,
): Omit<TopicNote, "name"> {
  const rawEntry = generatedNotes[`${subject} :: ${topic}`];
  // Reject entries that came from a disambiguation / list page — fall back to
  // the curriculum facts instead, which are always on-topic.
  const looksDisambig = rawEntry
    && (rawEntry.overview.some((p) => DISAMBIG.test(p))
      || rawEntry.subtopics.some((s) => DISAMBIG.test(s.name) || s.paragraphs.some((p) => DISAMBIG.test(p))));
  const raw = looksDisambig ? undefined : rawEntry;
  const generated = raw
    ? {
        ...raw,
        overview: stripHatnotes(raw.overview),
        subtopics: raw.subtopics.filter((s) => !DISAMBIG.test(s.name) && !s.paragraphs.some((p) => DISAMBIG.test(p))),
      }
    : undefined;
  const authored = authoredParts(curatedBlocks(subject, topic));
  const facts = factStatements(subject, topic, grade, band);

  const keyPoints: string[] = [];
  const seen = new Set<string>();
  for (const p of [...authored.keyPoints, ...facts]) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    keyPoints.push(p);
  }

  const sources = generated?.sources ?? [];
  // Rewrite the fetched drill-down sections into shorter, plainer paragraphs.
  const subtopics = (generated?.subtopics ?? [])
    .map((st) => ({ name: st.name, paragraphs: readable(st.paragraphs, band) }))
    .filter((st) => st.paragraphs.length > 0)
    .slice(0, band === "lower" ? 4 : 6);

  let overview: string[];
  const genOverview = generated ? readable(generated.overview, band) : [];
  if (genOverview.length > 0) {
    overview = genOverview;
  } else if (authored.overview.length > 0) {
    overview = readable(authored.overview, band);
  } else if (facts.length > 0 || subtopics.length > 0) {
    overview = [`Here is what you need to know about ${topic.toLowerCase()} for ${subject} in ${gradeWord(band)}.`];
  } else {
    overview = [`This is your ${subject} topic on ${topic.toLowerCase()}. Read the key points, then try the questions at the end.`];
  }

  return { overview, keyPoints: keyPoints.slice(0, 12), subtopics, sources };
}

export async function getStudyNotes(material: Material): Promise<StudyNote> {
  const g = resolveGrade(material.gradeKey);
  const generatedNotes = await loadGeneratedNotes();
  const guidance =
    SUBJECT_GUIDANCE[material.subject]?.[g.band] ??
    (g.band === "lower"
      ? "Read each part slowly. Say the key points out loud, then close the notes and see how many you remember."
      : g.band === "upper"
        ? "Read one section at a time. After each one, cover it and say the main idea in your own words before moving on."
        : "Work through a section, then close the notes and jot down the key points from memory. Fill any gaps by re-reading.");

  const topics: TopicNote[] = material.topics.map((name) => ({
    name,
    ...topicContent(generatedNotes, material.subject, name, g.band, g.grade),
  }));

  const practice = practiceQuestions(material, 6).map((q) => ({
    q: q.text,
    a: q.options[q.correct],
  }));

  const sources: NoteSource[] = [];
  const seenUrls = new Set<string>();
  for (const t of topics) {
    for (const s of t.sources) {
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);
      sources.push(s);
    }
  }

  return {
    title: material.title,
    subject: material.subject,
    gradeLabel: g.label,
    intro: guidance,
    topics,
    practice,
    sources,
  };
}
