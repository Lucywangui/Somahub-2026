import type { GradeBand } from "@/data/grade";
import type { Fact } from "../factbank";

import { FACTS as agriculture_and_nutrition_junior } from "./agriculture-and-nutrition/junior";
import { FACTS as agriculture_upper } from "./agriculture/upper";
import { FACTS as biology_junior } from "./biology/junior";
import { FACTS as biology_senior } from "./biology/senior";
import { FACTS as business_studies_junior } from "./business-studies/junior";
import { FACTS as business_studies_senior } from "./business-studies/senior";
import { FACTS as chemistry_junior } from "./chemistry/junior";
import { FACTS as chemistry_senior } from "./chemistry/senior";
import { FACTS as christian_religious_education_junior } from "./christian-religious-education/junior";
import { FACTS as christian_religious_education_lower } from "./christian-religious-education/lower";
import { FACTS as christian_religious_education_senior } from "./christian-religious-education/senior";
import { FACTS as christian_religious_education_upper } from "./christian-religious-education/upper";
import { FACTS as computer_science_junior } from "./computer-science/junior";
import { FACTS as computer_science_senior } from "./computer-science/senior";
import { FACTS as creative_arts_and_sports_junior } from "./creative-arts-and-sports/junior";
import { FACTS as creative_arts_lower } from "./creative-arts/lower";
import { FACTS as creative_arts_upper } from "./creative-arts/upper";
import { FACTS as english_junior } from "./english/junior";
import { FACTS as english_lower } from "./english/lower";
import { FACTS as english_senior } from "./english/senior";
import { FACTS as english_upper } from "./english/upper";
import { FACTS as environmental_activities_lower } from "./environmental-activities/lower";
import { FACTS as fasihi_ya_kiswahili_senior } from "./fasihi-ya-kiswahili/senior";
import { FACTS as geography_junior } from "./geography/junior";
import { FACTS as geography_senior } from "./geography/senior";
import { FACTS as history_and_citizenship_senior } from "./history-and-citizenship/senior";
import { FACTS as history_junior } from "./history/junior";
import { FACTS as history_senior } from "./history/senior";
import { FACTS as home_science_senior } from "./home-science/senior";
import { FACTS as home_science_upper } from "./home-science/upper";
import { FACTS as hygiene_and_nutrition_lower } from "./hygiene-and-nutrition/lower";
import { FACTS as integrated_science_junior } from "./integrated-science/junior";
import { FACTS as kiswahili_junior } from "./kiswahili/junior";
import { FACTS as kiswahili_lower } from "./kiswahili/lower";
import { FACTS as kiswahili_senior } from "./kiswahili/senior";
import { FACTS as kiswahili_upper } from "./kiswahili/upper";
import { FACTS as literature_senior } from "./literature/senior";
import { FACTS as physics_junior } from "./physics/junior";
import { FACTS as physics_senior } from "./physics/senior";
import { FACTS as pre_technical_studies_junior } from "./pre-technical-studies/junior";
import { FACTS as social_studies_junior } from "./social-studies/junior";
import { FACTS as social_studies_upper } from "./social-studies/upper";

/**
 * Authored question banks, by exact catalogue subject name and grade band.
 * Each file holds ~15 questions per syllabus topic, tagged with the exact
 * catalogue topic names. Validate with:
 *   npx vite-node scripts/check-question-bank.mts "<Subject>" <band>
 */
export const QUESTION_BANKS: Record<string, Partial<Record<GradeBand, Fact[]>>> = {
  "Agriculture and Nutrition": { junior: agriculture_and_nutrition_junior },
  "Agriculture": { upper: agriculture_upper },
  "Biology": { senior: biology_senior, junior: biology_junior },
  "Business Studies": { senior: business_studies_senior, junior: business_studies_junior },
  "Chemistry": { senior: chemistry_senior, junior: chemistry_junior },
  "Christian Religious Education": { lower: christian_religious_education_lower, upper: christian_religious_education_upper, junior: christian_religious_education_junior, senior: christian_religious_education_senior },
  "Computer Science": { senior: computer_science_senior, junior: computer_science_junior },
  "Creative Arts and Sports": { junior: creative_arts_and_sports_junior },
  "Creative Arts": { lower: creative_arts_lower, upper: creative_arts_upper },
  "English": { lower: english_lower, upper: english_upper, junior: english_junior, senior: english_senior },
  "Environmental Activities": { lower: environmental_activities_lower },
  "Fasihi ya Kiswahili": { senior: fasihi_ya_kiswahili_senior },
  "Geography": { senior: geography_senior, junior: geography_junior },
  "History and Citizenship": { senior: history_and_citizenship_senior },
  "History": { junior: history_junior, senior: history_senior },
  "Home Science": { upper: home_science_upper, senior: home_science_senior },
  "Hygiene and Nutrition": { lower: hygiene_and_nutrition_lower },
  "Integrated Science": { junior: integrated_science_junior },
  "Kiswahili": { lower: kiswahili_lower, upper: kiswahili_upper, junior: kiswahili_junior, senior: kiswahili_senior },
  "Literature": { senior: literature_senior },
  "Physics": { senior: physics_senior, junior: physics_junior },
  "Pre-Technical Studies": { junior: pre_technical_studies_junior },
  "Social Studies": { upper: social_studies_upper, junior: social_studies_junior },
};
