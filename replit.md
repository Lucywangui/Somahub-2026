# SOMA APP

SOMA APP helps learners find, purchase, and practise curriculum learning materials with multiple-choice questions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `PORT=22202 BASE_PATH=/ pnpm --filter @workspace/soma-app run dev` — run the SOMA learner app
- `pnpm --filter @workspace/soma-app run build:notes` — (maintainer, needs network) rebuild `src/data/notes.generated.ts` from open sources
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/soma-app/src/pages/` — onboarding and learner dashboard screens
- `artifacts/soma-app/src/components/` — material cards, viewers, wallet modal, and UI components
- `artifacts/soma-app/src/data/materials.ts` — curriculum material catalog
- `artifacts/soma-app/src/data/questions.ts` — thin entry point; delegates to the generator engine
- `artifacts/soma-app/src/data/generators/` — grade-parametric question generators + `generateQuiz`
- `artifacts/soma-app/src/data/generators/banks/<subject>/<band>.ts` — authored question banks (~15 per syllabus topic, tagged with exact catalogue topic names)
- `artifacts/soma-app/src/data/grade.ts` — maps a gradeKey to an exact grade (1–12) and band
- `artifacts/soma-app/src/data/studyNotes.ts` — assembles per-topic study notes for a material
- `artifacts/soma-app/src/data/notes.generated.ts` — generated note content (see `scripts/build-study-notes.mts`)
- `artifacts/soma-app/src/lib/storage.ts` — local learner state: name/grade/avatar, study intent, active (browsed) grade, coins, XP, streak, purchases, quiz results (with topics + rewards), quiz progress
- `artifacts/soma-app/src/lib/progress.ts` — pure helpers: XP→level, per-topic mastery from quiz history, daily counts
- `artifacts/soma-app/src/data/grade.ts` — CBE ladder (Grade 1–12) + levels (Lower/Upper Primary, Junior/Senior School); 8-4-4 Form 1–4 mapped to Grade 9–12; `adjacentGrades` for revision/stretch
- `artifacts/soma-app/src/data/assessment.ts` — KPSEA (Gr 6) / KJSEA (Gr 9) / KCSE (Gr 12) mapping, CBE performance levels, KCSE 12-point scale, SBA-weighted `projectExam`
- `artifacts/soma-app/src/data/curriculum.ts` — Senior School pathways (STEM / Social Sciences / Arts & Sports) + `visibleSubjects` filter
- `artifacts/soma-app/src/pages/IntentPage.tsx` / `PathwayPage.tsx` — onboarding: study intent, then pathway (Senior School only)
- `artifacts/soma-app/src/pages/DashboardPage.tsx` — "Today" home (streak, level, daily goal, continue, weak-spot practice), Explore (grade switcher for revision/stretch), Library, Profile (mastery bars)

## Architecture decisions

- Question generation is offline and deterministic. Each (grade, subject) group has one fixed question pool (`questionPool`); `generateQuiz(material, count, attempt)` deals that pool out across the group's materials — on-topic questions first, then the least-used — so every material has its own fixed set and materials overlap as little as possible. `attempt` 0 is the material's permanent set; the learner's "new question set" button bumps the stored `quizAttempts[materialId]` to get an alternative stable set. Never seed from the clock.
- Study notes are offline too. `scripts/build-study-notes.mts` resolves each (subject, topic) to an article on an open wiki (Wikipedia / Simple English Wikipedia / Wikipedia Kiswahili — CC BY-SA 4.0), splits it into an **overview + navigable sub-topics** (from the article's sections), and bakes the result into `src/data/notes.generated.ts`. Runtime never hits the network. Derived notes are CC BY-SA 4.0 and each carries its source, shown on the notes screen.
- `getStudyNotes` layers content best-first: generated overview+sub-topics → hand-authored `TOPIC_NOTES` (as key points) → curriculum-fact statements, then appends worked revision questions from the quiz generator.
- All fetched note text is rewritten at read time for the learner's band by `readable()` in `studyNotes.ts`: keeps the opening definition, caps sentence count/length per band, drops etymology/meta/disambiguation sentences, and swaps common hard words for plain ones in primary bands. Entries that came from a disambiguation page are rejected and fall back to the fact statements.
- Learner progress, coin balance, purchases, quiz results, streak/XP, and in-progress quizzes (`quizProgress`, for resume) remain in browser storage, matching the original app's offline flow.
- Every question carries a worked `explanation`, shown after answering (topical) or in review/marking mode (exam).
- Coins are earned by finishing quizzes / keeping streaks and spent to open materials (flat 5); new users start with 100 so it never blocks learning.
- Grade flexibility: a learner has a home `grade` but can browse `activeGrade` up to two classes below (revision) or above (stretch) on the same curriculum ladder — see `adjacentGrades` in `data/grade.ts`.
- Senior exam papers (`resolveGrade(...).band === "senior"`) run under a live countdown in `ExamViewer` that auto-submits at zero.
- Modelled to the Kenyan CBE system: one Grade 1–12 ladder with real level names; Junior School shows the 9 rationalised learning areas (Agriculture merges with Home Science into "Agriculture and Nutrition"; Computer Science → Pre-Technical Studies; Health Education → Integrated Science); Senior School filters subjects by chosen pathway. Exam results show CBE performance levels (Below/Approaching/Meeting/Exceeding Expectation) for primary & junior, and the KCSE 12-point A–E scale for senior & 8-4-4. The Today screen shows a projected KPSEA/KJSEA/KCSE result blending practice history (SBA proxy) with best mock score (summative proxy) per KNEC-style weightings.

## Product

- Learners complete a short onboarding flow, choose a curriculum level, search materials, purchase them with wallet funds, and open topical or exam practice.
- Every opened material presents its own fixed 15 multiple-choice questions; reopening shows the same set.

## User preferences

- Keep the existing app structure and behavior; do not introduce a replacement framework or unrelated features.

## Gotchas

- The SOMA Vite config intentionally requires `PORT` and `BASE_PATH`; the preview workflow must provide both values.
- To add questions, edit a bank file and run `npx vite-node scripts/check-question-bank.mts "<Subject>" <band>` (from `artifacts/soma-app`); `npx vitest run src/data/generators` enforces bank validity and that every group has enough distinct questions for its materials.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
