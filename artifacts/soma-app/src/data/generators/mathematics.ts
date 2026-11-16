import type { GradeBand } from "@/data/grade";
import type { GenContext, Question, SubjectGenerator } from "./types";
import { buildMCQ, numericMCQ, pick, randInt, shuffle } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Mathematics — procedurally generated, tuned to the exact grade (1–12).
// Each builder returns 0..1 question; the generator calls them repeatedly with
// the seeded RNG until it has a large, varied pool.
// ─────────────────────────────────────────────────────────────────────────────

type Builder = (ctx: GenContext) => Question | null;

const items = ["oranges", "books", "pencils", "mangoes", "eggs", "chairs", "goats", "desks", "bananas", "cups"];

// ── Grades 1–3: counting, addition, subtraction, shapes, money, time ─────────
const addSmall: Builder = ({ rng, grade }) => {
  const max = grade === 1 ? 10 : grade === 2 ? 50 : 100;
  const a = randInt(rng, 1, max), b = randInt(rng, 1, max);
  return numericMCQ(rng, `What is ${a} + ${b}?`, a + b, { spread: 2, allowNegative: false, explanation: `${a} + ${b} = ${a + b}. Add the ones, then the tens, carrying when a column reaches ten.` });
};
const subSmall: Builder = ({ rng, grade }) => {
  const max = grade === 1 ? 10 : grade === 2 ? 50 : 100;
  const a = randInt(rng, 2, max), b = randInt(rng, 1, a);
  return numericMCQ(rng, `What is ${a} − ${b}?`, a - b, { spread: 2, allowNegative: false, explanation: `${a} − ${b} = ${a - b}. Check by adding: ${a - b} + ${b} = ${a}.` });
};
const wordSub: Builder = ({ rng, grade }) => {
  const item = pick(rng, items);
  const total = randInt(rng, 6, grade === 1 ? 20 : 60);
  const gone = randInt(rng, 1, total - 1);
  return numericMCQ(rng, `A shopkeeper had ${total} ${item} and sold ${gone}. How many are left?`, total - gone, { spread: 2, allowNegative: false, explanation: `Start with ${total}, take away the ${gone} sold: ${total} − ${gone} = ${total - gone}.` });
};
const countBy: Builder = ({ rng }) => {
  const step = pick(rng, [2, 5, 10]);
  const start = step * randInt(rng, 1, 6);
  const seq = [start, start + step, start + 2 * step, start + 3 * step];
  return numericMCQ(rng, `Count in ${step}s: ${seq.join(", ")}, ___?`, start + 4 * step, { spread: step });
};
const shapeSides: Builder = ({ rng }) => {
  const shapes: [string, number][] = [["triangle", 3], ["square", 4], ["rectangle", 4], ["pentagon", 5], ["hexagon", 6], ["octagon", 8]];
  const [name, sides] = pick(rng, shapes);
  return buildMCQ(rng, `How many sides does a ${name} have?`, String(sides), ["3", "4", "5", "6", "8", "10"]);
};
const moneyLower: Builder = ({ rng }) => {
  const a = randInt(rng, 1, 9) * 10, b = randInt(rng, 1, 9) * 5;
  return numericMCQ(rng, `You buy a pen for KSh ${a} and a rubber for KSh ${b}. What is the total?`, a + b, { spread: 5, unit: "", allowNegative: false });
};
const timeLower: Builder = ({ rng }) => {
  const facts: [string, string][] = [
    ["How many minutes are in one hour?", "60"], ["How many hours are in one day?", "24"],
    ["How many days are in one week?", "7"], ["How many months are in one year?", "12"],
  ];
  const [q, a] = pick(rng, facts);
  return buildMCQ(rng, q, a, ["7", "12", "24", "30", "60", "100", "365"]);
};

// ── Grades 4–6: multiplication, division, fractions, decimals, %, perimeter ──
const mult: Builder = ({ rng, grade }) => {
  const max = grade === 4 ? 12 : grade === 5 ? 20 : 30;
  const a = randInt(rng, 2, max), b = randInt(rng, 2, 12);
  return numericMCQ(rng, `What is ${a} × ${b}?`, a * b, { spread: a, explanation: `${a} × ${b} means ${b} groups of ${a} (or ${a} groups of ${b}) = ${a * b}.` });
};
const divide: Builder = ({ rng }) => {
  const b = randInt(rng, 2, 12), q = randInt(rng, 2, 15);
  return numericMCQ(rng, `What is ${b * q} ÷ ${b}?`, q, { spread: 1, explanation: `${b * q} ÷ ${b} asks how many ${b}s fit into ${b * q}. Since ${b} × ${q} = ${b * q}, the answer is ${q}.` });
};
const percentOf: Builder = ({ rng }) => {
  const p = pick(rng, [5, 10, 20, 25, 50, 75]);
  const base = pick(rng, [20, 40, 60, 80, 120, 200, 400]);
  return numericMCQ(rng, `What is ${p}% of ${base}?`, (p * base) / 100, { spread: Math.max(2, p), allowNegative: false, explanation: `${p}% = ${p}/100. So ${p}% of ${base} = ${base} ÷ 100 × ${p} = ${(p * base) / 100}.` });
};
const equivFraction: Builder = ({ rng }) => {
  const denom = pick(rng, [2, 3, 4, 5]);
  const num = randInt(rng, 1, denom - 1);
  const k = randInt(rng, 2, 4);
  const wrong = [`${num + 1}/${denom * k}`, `${num * k}/${denom}`, `${num}/${denom * k + 1}`, `${num * k + 1}/${denom * k}`];
  return buildMCQ(rng, `Which fraction is equivalent to ${num}/${denom}?`, `${num * k}/${denom * k}`, wrong);
};
const decimalFraction: Builder = ({ rng }) => {
  const pairs: [string, string][] = [["0.5", "1/2"], ["0.25", "1/4"], ["0.75", "3/4"], ["0.2", "1/5"], ["0.1", "1/10"], ["0.333", "1/3"]];
  const [dec, frac] = pick(rng, pairs);
  return buildMCQ(rng, `What is ${dec} written as a fraction?`, frac, pairs.map((p) => p[1]));
};
const perimeter: Builder = ({ rng }) => {
  const l = randInt(rng, 3, 20), w = randInt(rng, 2, l);
  return numericMCQ(rng, `A rectangle is ${l} cm by ${w} cm. What is its perimeter?`, 2 * (l + w), { unit: "cm", spread: 4, allowNegative: false });
};
const area: Builder = ({ rng }) => {
  const l = randInt(rng, 3, 20), w = randInt(rng, 2, 15);
  return numericMCQ(rng, `A rectangle is ${l} cm by ${w} cm. What is its area?`, l * w, { unit: "cm²", spread: l, allowNegative: false });
};
const meanOf: Builder = ({ rng }) => {
  const n = 3;
  const base = randInt(rng, 2, 20);
  const vals = [base, base + randInt(rng, 1, 6), base - randInt(rng, 0, 1)];
  const sum = vals.reduce((x, y) => x + y, 0);
  if (sum % n !== 0) vals[0] += n - (sum % n);
  const mean = vals.reduce((x, y) => x + y, 0) / n;
  return numericMCQ(rng, `What is the mean of ${vals.join(", ")}?`, mean, { spread: 2 });
};

// ── Grades 7–9: integers, algebra, ratios, indices, geometry ────────────────
const integerOps: Builder = ({ rng }) => {
  const a = randInt(rng, -12, 12), b = randInt(rng, -12, 12);
  return numericMCQ(rng, `Evaluate: (${a}) + (${b})`, a + b, { spread: 2, explanation: `Adding a negative moves left on the number line: (${a}) + (${b}) = ${a + b}.` });
};
const solveLinear: Builder = ({ rng }) => {
  const a = randInt(rng, 2, 6), x = randInt(rng, 2, 12), b = randInt(rng, 1, 15);
  const rhs = a * x + b;
  return numericMCQ(rng, `Solve for x: ${a}x + ${b} = ${rhs}`, x, { spread: 1, explanation: `Subtract ${b} from both sides: ${a}x = ${rhs - b}. Divide by ${a}: x = ${x}.` });
};
const ratioShare: Builder = ({ rng }) => {
  const total = pick(rng, [30, 40, 50, 60, 100, 120]);
  const r1 = randInt(rng, 1, 5), r2 = randInt(rng, 1, 5);
  if (r1 === r2) return null;
  const part = (total / (r1 + r2)) * r1;
  if (!Number.isInteger(part)) return null;
  return numericMCQ(rng, `Share KSh ${total} between two people in the ratio ${r1}:${r2}. How much does the first person get?`, part, { spread: 5, allowNegative: false });
};
const indices: Builder = ({ rng }) => {
  const base = randInt(rng, 2, 6), exp = randInt(rng, 2, 3);
  return numericMCQ(rng, `Evaluate: ${base}^${exp}`, Math.pow(base, exp), { spread: base });
};
const circleCirc: Builder = ({ rng }) => {
  const r = randInt(rng, 2, 10);
  return numericMCQ(rng, `Find the circumference of a circle of radius ${r} cm. (Take π = 3.14)`, Math.round(2 * 3.14 * r * 100) / 100, { unit: "cm", spread: 4, allowNegative: false });
};
const pythagoras: Builder = ({ rng }) => {
  const triples: [number, number, number][] = [[3, 4, 5], [6, 8, 10], [5, 12, 13], [8, 15, 17], [9, 12, 15]];
  const [a, b, c] = pick(rng, triples);
  return numericMCQ(rng, `A right-angled triangle has legs ${a} cm and ${b} cm. Find the hypotenuse.`, c, { unit: "cm", spread: 2, allowNegative: false, explanation: `Pythagoras: c² = ${a}² + ${b}² = ${a * a} + ${b * b} = ${a * a + b * b}. So c = √${a * a + b * b} = ${c} cm.` });
};

// ── Grades 10–12 / Forms: quadratics, trig, sequences, calculus, logs ───────
const quadraticRoots: Builder = ({ rng }) => {
  const p = randInt(rng, 1, 6), q = randInt(rng, 1, 6);
  // (x - p)(x - q) = x^2 - (p+q)x + pq
  const b = -(p + q), c = p * q;
  const roots = p === q ? `x = ${p}` : `x = ${p} or x = ${q}`;
  const wrong = [`x = ${-p} or x = ${-q}`, `x = ${p + q}`, `x = ${Math.abs(b)} or x = ${c}`, `x = ${p} or x = ${-q}`];
  return buildMCQ(rng, `Solve: x² ${b < 0 ? "− " + -b : "+ " + b}x + ${c} = 0`, roots, wrong,
    `Factorise into (x − ${p})(x − ${q}) = 0, since ${p} + ${q} = ${p + q} and ${p} × ${q} = ${c}. So ${roots}.`);
};
const trigValue: Builder = ({ rng }) => {
  const table: Record<string, Record<string, string>> = {
    "0°": { sin: "0", cos: "1", tan: "0" },
    "30°": { sin: "0.5", cos: "0.866", tan: "0.577" },
    "45°": { sin: "0.707", cos: "0.707", tan: "1" },
    "60°": { sin: "0.866", cos: "0.5", tan: "1.732" },
    "90°": { sin: "1", cos: "0", tan: "undefined" },
  };
  const angle = pick(rng, Object.keys(table));
  const fn = pick(rng, ["sin", "cos", "tan"]);
  const answer = table[angle][fn];
  const all = new Set<string>();
  Object.values(table).forEach((row) => Object.values(row).forEach((v) => all.add(v)));
  return buildMCQ(rng, `Evaluate ${fn}(${angle}).`, answer, [...all].filter((v) => v !== answer));
};
const arithmeticSeq: Builder = ({ rng }) => {
  const a = randInt(rng, 1, 9), d = randInt(rng, 2, 7), n = randInt(rng, 6, 12);
  return numericMCQ(rng, `An arithmetic sequence has first term ${a} and common difference ${d}. Find the ${n}th term.`, a + (n - 1) * d, { spread: d });
};
const differentiate: Builder = ({ rng }) => {
  const a = randInt(rng, 2, 6), b = randInt(rng, 1, 8), c = randInt(rng, 1, 9);
  const answer = `${a * 3}x² + ${b * 2}x + ${c}`;
  const wrong = [`${a * 3}x² + ${b}x`, `${a}x³ + ${b}x²`, `${a * 2}x + ${b}`, `${a * 3}x² + ${b * 2}x + ${c}x`];
  return buildMCQ(rng, `Differentiate y = ${a}x³ + ${b}x² + ${c}x + 4 with respect to x.`, answer, wrong);
};
const integrate: Builder = ({ rng }) => {
  const a = randInt(rng, 2, 6), b = randInt(rng, 2, 8);
  const answer = `${a / 2 === Math.floor(a / 2) ? a / 2 : a + "/2"}x² + ${b}x + c`;
  const wrong = [`${a}x² + ${b}x + c`, `${a * 2}x + ${b} + c`, `${a}x³ + ${b}x² + c`, `${a}x + ${b} + c`];
  return buildMCQ(rng, `Find ∫(${a}x + ${b}) dx.`, answer, wrong);
};
const logValue: Builder = ({ rng }) => {
  const base = pick(rng, [2, 3, 5, 10]);
  const exp = randInt(rng, 2, 4);
  return numericMCQ(rng, `Evaluate log${base}(${Math.pow(base, exp)}).`, exp, { spread: 1 });
};

const BUILDERS_BY_GRADE: Record<number, Builder[]> = {
  1: [addSmall, subSmall, countBy, shapeSides, wordSub],
  2: [addSmall, subSmall, countBy, shapeSides, wordSub, moneyLower, timeLower],
  3: [addSmall, subSmall, wordSub, shapeSides, moneyLower, timeLower, countBy],
  4: [mult, divide, addSmall, equivFraction, perimeter, meanOf, timeLower],
  5: [mult, divide, equivFraction, decimalFraction, percentOf, perimeter, area],
  6: [mult, divide, decimalFraction, percentOf, perimeter, area, meanOf, equivFraction],
  7: [integerOps, solveLinear, percentOf, ratioShare, indices, area, meanOf],
  8: [solveLinear, integerOps, ratioShare, indices, circleCirc, pythagoras, percentOf],
  9: [solveLinear, ratioShare, indices, circleCirc, pythagoras, arithmeticSeq, integerOps],
  10: [quadraticRoots, arithmeticSeq, trigValue, pythagoras, indices, solveLinear, logValue],
  11: [quadraticRoots, trigValue, arithmeticSeq, differentiate, logValue, indices],
  12: [quadraticRoots, trigValue, differentiate, integrate, arithmeticSeq, logValue],
};

// Which catalogue topics (exact names from materials.ts) each builder tests, per
// grade band. Untagged builders still feed exams but never pad a topical quiz.
const BUILDER_TOPICS: Record<GradeBand, Map<Builder, string[]>> = {
  lower: new Map<Builder, string[]>([
    [addSmall, ["Addition"]],
    [subSmall, ["Subtraction"]],
    [wordSub, ["Subtraction"]],
    [countBy, ["Patterns & Sequences", "Numbers 1–100"]],
    [shapeSides, ["Shapes & Geometry"]],
    [moneyLower, ["Money (KSh)"]],
    [timeLower, ["Time & Calendar"]],
  ]),
  upper: new Map<Builder, string[]>([
    [addSmall, ["Whole Numbers & Place Value"]],
    [mult, ["Whole Numbers & Place Value"]],
    [divide, ["Whole Numbers & Place Value"]],
    [equivFraction, ["Fractions & Decimals"]],
    [decimalFraction, ["Fractions & Decimals"]],
    [percentOf, ["Percentages & Ratios"]],
    [perimeter, ["Area & Perimeter"]],
    [area, ["Area & Perimeter"]],
    [meanOf, ["Data & Statistics"]],
  ]),
  junior: new Map<Builder, string[]>([
    [integerOps, ["Number Theory & Operations"]],
    [indices, ["Number Theory & Operations"]],
    [solveLinear, ["Algebra & Linear Equations"]],
    [ratioShare, ["Financial Mathematics"]],
    [meanOf, ["Statistics & Probability"]],
    [pythagoras, ["Geometry & Triangles"]],
    [arithmeticSeq, ["Sequences, Series & Binomial"]],
  ]),
  senior: new Map<Builder, string[]>([
    [quadraticRoots, ["Algebra & Functions"]],
    [solveLinear, ["Algebra & Functions"]],
    [logValue, ["Algebra & Functions"]],
    [indices, ["Algebra & Surds"]],
    [arithmeticSeq, ["Sequences & Series", "Sequences, Series & Binomial"]],
    [trigValue, ["Trigonometry", "Trigonometry & Identities"]],
    [differentiate, ["Differentiation (Calculus)", "Differentiation"]],
    [integrate, ["Integration (Calculus)", "Integration & Applications"]],
  ]),
};

export const mathematicsGenerator: SubjectGenerator = (ctx) => {
  const builders = BUILDERS_BY_GRADE[ctx.grade] ?? BUILDERS_BY_GRADE[6];
  const tags = BUILDER_TOPICS[ctx.band];
  const out: Question[] = [];
  // Draw generously so the engine can dedupe down to a full unique quiz.
  for (let attempt = 0; attempt < 220 && out.length < 60; attempt++) {
    const b = builders[attempt % builders.length];
    const q = b(ctx);
    if (!q) continue;
    const topics = tags.get(b);
    out.push(topics ? { ...q, topics } : q);
  }
  return shuffle(ctx.rng, out);
};
