---
name: Generator template integrity
description: Durable constraints for maintaining SOMA's curriculum question banks
---

SOMA's questions come from `artifacts/soma-app/src/data/generators/`: the original content files plus authored banks in `banks/<subject>/<band>.ts`. Every question is one stem, one correct answer, three distinct wrong answers, catalogue topic tags, and a `why`. (The old `components/Generators/*Templates.ts` files were empty and have been removed.)

**Why:** Each grade+subject group has 30 materials × 15 questions. When the pool is small, every material shows the same questions, and if questions are seeded from the clock they change on every open. Both were reported by users.

**How to apply:** Never seed `generateQuiz` with `Date.now()`. Use attempt 0, or the stored `quizAttempts` value. When adding content, tag it with exact topic names, run `scripts/check-question-bank.mts`, then `vitest run src/data/generators`. The supply test fails if any group drops below its minimum pool size.
