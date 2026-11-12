import type { GradeBand } from "@/data/grade";
import { resolveFacts, type Fact, type FactBankConfig } from "./factbank";

import { ENGLISH_FACTS, LITERATURE_FACTS } from "./content/english";
import { KISWAHILI_FACTS, FASIHI_FACTS } from "./content/kiswahili";
import { ENV_FACTS, INTEGRATED, BIOLOGY, CHEMISTRY, PHYSICS } from "./content/science";
import { SOCIAL_FACTS, HISTORY_FACTS, GEOGRAPHY_FACTS, BUSINESS_FACTS, CRE_FACTS } from "./content/humanities";
import { AGRICULTURE_FACTS, AGRICULTURE_NUTRITION_FACTS, HOME_SCIENCE_FACTS, HYGIENE_FACTS, HEALTH_FACTS, TECH_FACTS } from "./content/practical";
import { ARTS_FACTS, ARTS_SPORTS_FACTS } from "./content/arts";

/**
 * The same curriculum fact banks the quiz generator uses, indexed by subject so
 * study notes can surface them as plain statements for any topic.
 */
export const SUBJECT_FACTS: Record<string, FactBankConfig> = {
  English: ENGLISH_FACTS,
  Literature: LITERATURE_FACTS,
  Kiswahili: KISWAHILI_FACTS,
  "Fasihi ya Kiswahili": FASIHI_FACTS,
  "Environmental Activities": ENV_FACTS,
  "Integrated Science": INTEGRATED,
  Biology: BIOLOGY,
  Chemistry: CHEMISTRY,
  Physics: PHYSICS,
  "Social Studies": SOCIAL_FACTS,
  Geography: GEOGRAPHY_FACTS,
  "History and Citizenship": HISTORY_FACTS,
  History: HISTORY_FACTS,
  "Business Studies": BUSINESS_FACTS,
  "Christian Religious Education": CRE_FACTS,
  Agriculture: AGRICULTURE_FACTS,
  "Agriculture and Nutrition": AGRICULTURE_NUTRITION_FACTS,
  "Home Science": HOME_SCIENCE_FACTS,
  "Hygiene and Nutrition": HYGIENE_FACTS,
  "Health Education": HEALTH_FACTS,
  "Pre-Technical Studies": TECH_FACTS,
  "Computer Science": TECH_FACTS,
  "Creative Arts": ARTS_FACTS,
  "Creative Arts and Sports": ARTS_SPORTS_FACTS,
};

/** Facts from the original hand-written content files only (no authored banks). */
export function contentFactsForSubject(subject: string, grade: number, band: GradeBand): Fact[] {
  const cfg = SUBJECT_FACTS[subject];
  if (!cfg) return [];
  return resolveFacts(cfg, { grade, band });
}
