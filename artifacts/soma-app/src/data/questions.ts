import type { Material } from "./materials";
import { generateQuiz, type Question } from "./generators";

export type { Question };

/**
 * The questions for a material — fully offline and deterministic.
 *
 * @param attempt  0 (default) = the material's fixed question set, identical
 *                 every time it is opened. Pass the stored attempt number
 *                 (`quizAttempts[material.id]`) after the learner asks for a
 *                 new question set. Never pass a clock value here.
 */
export function getQuestionsForMaterial(
  material: Material,
  count: number,
  attempt = 0,
): Question[] {
  return generateQuiz(material, count, attempt);
}
