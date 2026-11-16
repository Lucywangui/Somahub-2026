import type { Material } from "./materials";
import { generateQuiz, type Question } from "./generators";

export type { Question };

/**
 * The questions for a material — fully offline and deterministic: a material
 * always has the same fixed set, identical every time it is opened. There is
 * deliberately no way for a learner to regenerate it; more practice means
 * unlocking another material.
 */
export function getQuestionsForMaterial(
  material: Material,
  count: number,
): Question[] {
  return generateQuiz(material, count);
}
