import { create } from "zustand";

import type { Question } from "@/data/questions";
import type { Pathway } from "@/data/curriculum";

/** A quiz the learner started but has not finished — lets them resume later. */
export interface QuizProgress {
  materialId: string;
  type: "topical" | "exam";
  questions: Question[];
  answers: Record<number, string>;
  currentIndex: number;
  score: number;
  startedAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  type: "deposit" | "purchase" | "reward";
  amount: number;
  description: string;
  date: string;
}

/** Balances and unlocks as the server reports them. */
export interface ServerAccount {
  coins: number;
  ksh: number;
  unlocked: string[];
  earnedToday: number;
  imported: boolean;
  prices: Prices;
  subscription: Subscription | null;
}

export interface Prices {
  materialCoins: number;
  kshPerCoin: number;
  dailyCap: number;
  subscriptionKsh: number;
  subscriptionDays: number;
}

export interface Subscription {
  gradeKey: string;
  /** Server local time, "YYYY-MM-DD HH:MM:SS". */
  expiresAt: string;
  active: boolean;
}

const DEFAULT_PRICES: Prices = {
  materialCoins: 5,
  kshPerCoin: 1,
  dailyCap: 0,
  subscriptionKsh: 100,
  subscriptionDays: 30,
};

/** Material IDs start with their grade key, e.g. cbc-7-english-... */
export function subscriptionCovers(
  subscription: Subscription | null,
  materialId: string
): boolean {
  return (
    !!subscription &&
    subscription.active &&
    materialId.startsWith(subscription.gradeKey + "-")
  );
}

export interface QuizResult {
  id: string;
  materialId: string;
  materialTitle: string;
  subject: string;
  gradeKey: string;
  topics: string[];
  type: "topical" | "exam";
  score: number;
  total: number;
  percentage: number;
  xpEarned: number;
  coinsEarned: number;
  date: string;
}

export type StudyIntent =
  | "exam"
  | "keep-up"
  | "catch-up"
  | "get-ahead";

export interface Streak {
  count: number;
  best: number;
  lastActiveDate: string;
}

/* =========================================================
   SOMA HUB TERM PERFORMANCE
   ========================================================= */

export type SchoolTerm = 1 | 2 | 3;

export type TermPointCategory =
  | "studyNotes"
  | "topicalQuizzes"
  | "exams"
  | "consistency"
  | "progress";

export interface TermPoints {
  year: number;
  term: SchoolTerm;
  studyNotes: number;
  topicalQuizzes: number;
  exams: number;
  consistency: number;
  progress: number;
}

export const TERM_POINT_LIMITS: Record<
  TermPointCategory,
  number
> = {
  studyNotes: 20,
  topicalQuizzes: 25,
  exams: 25,
  consistency: 15,
  progress: 15,
};

export const STUDY_NOTES_POINTS_PER_COMPLETION = 2;
export const TOPICAL_QUIZ_TERM_POINTS = 5;
export const EXAM_TERM_POINTS = 8;
export const CONSISTENCY_TERM_POINTS = 2;

/**
 * Progress rule:
 * Every 5 percentage points of improvement
 * in quiz/exam performance earns 1 progress point.
 */
export const PROGRESS_PERCENTAGE_STEP = 5;
export const PROGRESS_POINTS_PER_STEP = 1;
export const MAX_TERM_POINTS = 100;

export function getTermPointsTotal(
  termPoints: TermPoints
): number {
  return Math.min(
    MAX_TERM_POINTS,
    termPoints.studyNotes +
      termPoints.topicalQuizzes +
      termPoints.exams +
      termPoints.consistency +
      termPoints.progress
  );
}

export function getCurrentSchoolTerm(
  date = new Date()
): {
  year: number;
  term: SchoolTerm;
} {
  const month = date.getMonth();

  if (month <= 3) {
    return {
      year: date.getFullYear(),
      term: 1,
    };
  }

  if (month <= 7) {
    return {
      year: date.getFullYear(),
      term: 2,
    };
  }

  return {
    year: date.getFullYear(),
    term: 3,
  };
}

function createEmptyTermPoints(
  year: number,
  term: SchoolTerm
): TermPoints {
  return {
    year,
    term,
    studyNotes: 0,
    topicalQuizzes: 0,
    exams: 0,
    consistency: 0,
    progress: 0,
  };
}

/* =========================================================
   STUDENT CODE
   ========================================================= */

function generateSomaHubCode(): string {
  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "SH-";

  for (let i = 0; i < 6; i += 1) {
    code += characters.charAt(
      Math.floor(
        Math.random() * characters.length
      )
    );
  }

  return code;
}

function getOrCreateSomaHubCode(): string {
  try {
    const existing =
      localStorage.getItem(
        "soma_hub_code"
      );

    if (existing) {
      try {
        return JSON.parse(existing);
      } catch {
        return existing;
      }
    }

    const newCode =
      generateSomaHubCode();

    localStorage.setItem(
      "soma_hub_code",
      JSON.stringify(newCode)
    );

    return newCode;
  } catch {
    return generateSomaHubCode();
  }
}

/* =========================================================
   BACKEND SYNCHRONIZATION
   ========================================================= */

export const SOMA_API_BASE_URL =
  (
    import.meta.env
      .VITE_API_BASE_URL as
      | string
      | undefined
  )?.replace(/\/$/, "") ||
  "http://127.0.0.1:5000";

export async function syncStudentToBackend(data: {
  soma_hub_code: string;
  name: string;
  school_name: string;
  grade: string;
}): Promise<void> {
  console.log(
    "[SOMA HUB] Starting backend sync:",
    data
  );

  if (
    !data.soma_hub_code ||
    !data.name
  ) {
    console.warn(
      "[SOMA HUB] Sync skipped because SOMA HUB Code or name is missing:",
      data
    );
    return;
  }

  try {
    const response =
      await fetch(
        SOMA_API_BASE_URL +
          "/api/students/register",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify(data),
        }
      );

    const responseText =
      await response.text();

    console.log(
      "[SOMA HUB] Backend response:",
      response.status,
      responseText
    );

    if (!response.ok) {
      console.error(
        "[SOMA HUB] Backend rejected student:",
        response.status,
        responseText
      );
    } else {
      console.log(
        "[SOMA HUB] Student successfully synced to backend."
      );
    }
  } catch (error) {
    console.error(
      "[SOMA HUB] Backend sync failed:",
      error
    );
  }
}

/* =========================================================
   PERFORMANCE BACKEND SYNCHRONIZATION
   ========================================================= */

async function syncStudentPerformanceToBackend(
  data: {
    soma_hub_code: string;
    term_points: TermPoints[];
    quiz_results: QuizResult[];
  }
): Promise<void> {
  console.log(
    "[SOMA HUB] Starting performance sync:",
    data
  );

  if (!data.soma_hub_code) {
    console.warn(
      "[SOMA HUB] Performance sync skipped because SOMA HUB Code is missing."
    );
    return;
  }

  try {
    const response = await fetch(
      SOMA_API_BASE_URL +
        "/api/students/performance",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },

        /*
         * IMPORTANT:
         * These top-level keys match the backend performance API.
         * The calculations above are not changed.
         */
        body: JSON.stringify({
          somaHubCode:
            data.soma_hub_code,

          termPoints:
            data.term_points.map(
              (term) => ({
                termKey:
                  `${term.year}-T${term.term}`,
                studyNotes:
                  term.studyNotes,
                topicalQuizzes:
                  term.topicalQuizzes,
                exams:
                  term.exams,
                consistency:
                  term.consistency,
                progress:
                  term.progress,
                totalPoints:
                  getTermPointsTotal(term),
              })
            ),

          quizResults:
            data.quiz_results.map(
              (result) => ({
                materialId:
                  result.materialId,
                materialTitle:
                  result.materialTitle,
                subject:
                  result.subject,
                gradeKey:
                  result.gradeKey,
                type:
                  result.type,
                score:
                  result.score,
                total:
                  result.total,
                percentage:
                  result.percentage,
                date:
                  result.date,
              })
            ),
        }),
      }
    );

    const responseText =
      await response.text();

    console.log(
      "[SOMA HUB] Performance backend response:",
      response.status,
      responseText
    );

    if (!response.ok) {
      console.error(
        "[SOMA HUB] Performance sync rejected:",
        response.status,
        responseText
      );
    } else {
      console.log(
        "[SOMA HUB] Performance successfully synced."
      );
    }
  } catch (error) {
    console.error(
      "[SOMA HUB] Performance sync failed:",
      error
    );
  }
}

/* =========================================================
   STORE
   ========================================================= */

interface SomaState {
  name: string | null;
  avatar: string | null;
  grade: string | null;
  schoolName: string | null;
  somaHubCode: string;
  studyIntent: StudyIntent | null;
  pathway: Pathway | null;
  activeGrade: string | null;

  /**
   * SOMA Points.
   *
   * These are now exactly equal to the real-money wallet
   * balance reported by the server.
   */
  wallet: number;

  /** Real wallet balance in KSh. */
  ksh: number | null;

  prices: Prices;
  subscription: Subscription | null;
  xp: number;
  streak: Streak;
  dailyGoal: number;

  /** Unlocked materials shown in the library. */
  purchased: string[];

  /** Unlocked materials hidden from the library. */
  libraryHidden: string[];

  transactions: Transaction[];
  quizResults: QuizResult[];
  quizProgress: Record<string, QuizProgress>;
  termPoints: Record<string, TermPoints>;
  studyNotesCompleted: Record<string, string[]>;

  setName: (name: string) => void;
  setAvatar: (avatar: string) => void;
  setGrade: (grade: string) => void;
  setSchoolName: (
    schoolName: string
  ) => void;

  setStudyIntent: (
    intent: StudyIntent
  ) => void;

  setPathway: (
    pathway: Pathway | null
  ) => void;

  setActiveGrade: (
    grade: string | null
  ) => void;

  setDailyGoal: (n: number) => void;

  addTermPoints: (
    category: TermPointCategory,
    amount: number
  ) => number;

  completeStudyNotes: (
    materialId: string
  ) => number;

  applyAccount: (
    account: ServerAccount
  ) => void;

  showInLibrary: (
    id: string
  ) => void;

  removePurchased: (
    id: string
  ) => void;

  addQuizResult: (
    result: Omit<
      QuizResult,
      | "id"
      | "date"
      | "xpEarned"
      | "coinsEarned"
    >
  ) => {
    xpEarned: number;
    coinsEarned: number;
    streak: Streak;
  };

  saveQuizProgress: (
    progress: QuizProgress
  ) => void;

  clearQuizProgress: (
    materialId: string
  ) => void;

  logout: () => void;
}

const KEYS = [
  "soma_name",
  "soma_avatar",
  "soma_grade",
  "soma_school_name",
  "soma_hub_code",
  "soma_intent",
  "soma_pathway",
  "soma_active_grade",
  "soma_wallet",
  "soma_xp",
  "soma_streak",
  "soma_daily_goal",
  "soma_purchased",
  "soma_library_hidden",
  "soma_ksh",
  "soma_subscription",
  "soma_reward_outbox",
  "soma_transactions",
  "soma_quiz_results",
  "soma_quiz_progress",
  "soma_term_points",
  "soma_study_notes_completed",
];

const EMPTY_STREAK: Streak = {
  count: 0,
  best: 0,
  lastActiveDate: "",
};

export const useSomaStore =
  create<SomaState>((set, get) => {
    const loadState = <T>(
      key: string,
      defaultValue: T
    ): T => {
      try {
        const stored =
          localStorage.getItem(key);

        return stored
          ? JSON.parse(stored)
          : defaultValue;
      } catch {
        return defaultValue;
      }
    };

    const save = (
      key: string,
      value: unknown
    ) => {
      try {
        localStorage.setItem(
          key,
          JSON.stringify(value)
        );
      } catch {
        /* private mode */
      }
    };

    const initialSomaHubCode =
      getOrCreateSomaHubCode();

    const initialName =
      loadState<string | null>(
        "soma_name",
        null
      );

    const initialSchoolName =
      loadState<string | null>(
        "soma_school_name",
        null
      );

    const initialGrade =
      loadState<string | null>(
        "soma_grade",
        null
      );

    /*
     * If this device already has a student account,
     * synchronize that existing account with Flask.
     *
     * This does NOT create a new SOMA HUB Code.
     */
    if (initialName) {
      void syncStudentToBackend({
        soma_hub_code:
          initialSomaHubCode,
        name:
          initialName,
        school_name:
          initialSchoolName ?? "",
        grade:
          initialGrade ?? "",
      });
    }

    return {
      name: initialName,

      avatar:
        loadState<string | null>(
          "soma_avatar",
          null
        ),

      grade: initialGrade,

      schoolName:
        initialSchoolName,

      somaHubCode:
        initialSomaHubCode,

      studyIntent:
        loadState<StudyIntent | null>(
          "soma_intent",
          null
        ),

      pathway:
        loadState<Pathway | null>(
          "soma_pathway",
          null
        ),

      activeGrade:
        loadState<string | null>(
          "soma_active_grade",
          null
        ),

      /*
       * IMPORTANT:
       * No free starting points.
       *
       * The server will supply the real paid balance.
       */
      wallet:
        loadState<number>(
          "soma_wallet",
          0
        ),

      ksh:
        loadState<number | null>(
          "soma_ksh",
          null
        ),

      prices:
        DEFAULT_PRICES,

      subscription:
        loadState<Subscription | null>(
          "soma_subscription",
          null
        ),

      xp:
        loadState<number>(
          "soma_xp",
          0
        ),

      streak:
        loadState<Streak>(
          "soma_streak",
          EMPTY_STREAK
        ),

      dailyGoal:
        loadState<number>(
          "soma_daily_goal",
          2
        ),

      purchased:
        loadState<string[]>(
          "soma_purchased",
          []
        ),

      libraryHidden:
        loadState<string[]>(
          "soma_library_hidden",
          []
        ),

      transactions:
        loadState<Transaction[]>(
          "soma_transactions",
          []
        ),

      quizResults:
        loadState<QuizResult[]>(
          "soma_quiz_results",
          []
        ),

      quizProgress:
        loadState<
          Record<string, QuizProgress>
        >(
          "soma_quiz_progress",
          {}
        ),

      termPoints:
        loadState<
          Record<string, TermPoints>
        >(
          "soma_term_points",
          {}
        ),

      studyNotesCompleted:
        loadState<
          Record<string, string[]>
        >(
          "soma_study_notes_completed",
          {}
        ),

      /* =====================================================
         PROFILE
         ===================================================== */

      setName: (name) => {
        save(
          "soma_name",
          name
        );

        set({ name });

        const state = get();

        void syncStudentToBackend({
          soma_hub_code:
            state.somaHubCode,
          name,
          school_name:
            state.schoolName ?? "",
          grade:
            state.grade ?? "",
        });
      },

      setAvatar: (avatar) => {
        save(
          "soma_avatar",
          avatar
        );

        set({ avatar });
      },

      setGrade: (grade) => {
        save(
          "soma_grade",
          grade
        );

        save(
          "soma_active_grade",
          null
        );

        set({
          grade,
          activeGrade: null,
        });

        const state = get();

        if (state.name) {
          void syncStudentToBackend({
            soma_hub_code:
              state.somaHubCode,
            name:
              state.name,
            school_name:
              state.schoolName ?? "",
            grade,
          });
        }
      },

      setSchoolName: (
        schoolName
      ) => {
        save(
          "soma_school_name",
          schoolName
        );

        set({
          schoolName,
        });

        const state = get();

        if (state.name) {
          void syncStudentToBackend({
            soma_hub_code:
              state.somaHubCode,
            name:
              state.name,
            school_name:
              schoolName,
            grade:
              state.grade ?? "",
          });
        }
      },

      setStudyIntent: (
        studyIntent
      ) => {
        save(
          "soma_intent",
          studyIntent
        );

        set({
          studyIntent,
        });
      },

      setPathway: (
        pathway
      ) => {
        save(
          "soma_pathway",
          pathway
        );

        set({
          pathway,
        });
      },

      setActiveGrade: (
        activeGrade
      ) => {
        save(
          "soma_active_grade",
          activeGrade
        );

        set({
          activeGrade,
        });
      },

      setDailyGoal: (
        dailyGoal
      ) => {
        save(
          "soma_daily_goal",
          dailyGoal
        );

        set({
          dailyGoal,
        });
      },

      /* =====================================================
         TERM POINTS
         ===================================================== */

      addTermPoints: (
        category,
        amount
      ) => {
        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return 0;
        }

        const state = get();

        const {
          year,
          term,
        } =
          getCurrentSchoolTerm();

        const termKey =
          `${year}-T${term}`;

        const existing =
          state.termPoints[
            termKey
          ] ??
          createEmptyTermPoints(
            year,
            term
          );

        const categoryLimit =
          TERM_POINT_LIMITS[
            category
          ];

        const currentCategoryValue =
          existing[category];

        const currentTotal =
          getTermPointsTotal(
            existing
          );

        const availableOverall =
          MAX_TERM_POINTS -
          currentTotal;

        if (
          availableOverall <= 0
        ) {
          return 0;
        }

        const pointsToAdd =
          Math.min(
            amount,
            categoryLimit -
              currentCategoryValue,
            availableOverall
          );

        if (
          pointsToAdd <= 0
        ) {
          return 0;
        }

        const updatedTerm:
          TermPoints = {
            ...existing,
            [category]:
              currentCategoryValue +
              pointsToAdd,
          };

        const termPoints = {
          ...state.termPoints,
          [termKey]:
            updatedTerm,
        };

        save(
          "soma_term_points",
          termPoints
        );

        set({
          termPoints,
        });

        const latestState =
          get();

        void syncStudentPerformanceToBackend({
          soma_hub_code:
            latestState.somaHubCode,

          term_points:
            Object.values(
              latestState.termPoints
            ),

          quiz_results:
            latestState.quizResults,
        });

        return pointsToAdd;
      },

      /* =====================================================
         STUDY NOTES TERM POINTS
         ===================================================== */

      completeStudyNotes: (
        materialId
      ) => {
        if (!materialId) {
          return 0;
        }

        const state = get();

        const {
          year,
          term,
        } =
          getCurrentSchoolTerm();

        const termKey =
          `${year}-T${term}`;

        const completedForTerm =
          state.studyNotesCompleted[
            termKey
          ] ?? [];

        if (
          completedForTerm.includes(
            materialId
          )
        ) {
          return 0;
        }

        const pointsAwarded =
          get().addTermPoints(
            "studyNotes",
            STUDY_NOTES_POINTS_PER_COMPLETION
          );

        const updatedCompletedForTerm =
          [
            ...completedForTerm,
            materialId,
          ];

        const studyNotesCompleted =
          {
            ...state.studyNotesCompleted,
            [termKey]:
              updatedCompletedForTerm,
          };

        save(
          "soma_study_notes_completed",
          studyNotesCompleted
        );

        set({
          studyNotesCompleted,
        });

        const latestState =
          get();

        void syncStudentPerformanceToBackend({
          soma_hub_code:
            latestState.somaHubCode,

          term_points:
            Object.values(
              latestState.termPoints
            ),

          quiz_results:
            latestState.quizResults,
        });

        return pointsAwarded;
      },

      /* =====================================================
         WALLET / PAID SOMA POINTS
         ===================================================== */

      applyAccount: (
        account
      ) => {
        set((state) => {
          const unlocked =
            new Set(
              account.unlocked
            );

          const libraryHidden =
            state.libraryHidden.filter(
              (id) =>
                unlocked.has(id)
            );

          const purchased =
            account.unlocked.filter(
              (id) =>
                !libraryHidden.includes(
                  id
                )
            );

          /*
           * IMPORTANT:
           *
           * account.coins is now the server's paid wallet
           * balance.
           *
           * Example:
           * KSh 50 paid -> wallet 50 -> SOMA Points 50
           */

          save(
            "soma_wallet",
            account.coins
          );

          save(
            "soma_ksh",
            account.ksh
          );

          save(
            "soma_subscription",
            account.subscription
          );

          save(
            "soma_purchased",
            purchased
          );

          save(
            "soma_library_hidden",
            libraryHidden
          );

          return {
            wallet:
              account.coins,

            ksh:
              account.ksh,

            prices:
              account.prices,

            subscription:
              account.subscription,

            purchased,

            libraryHidden,
          };
        });
      },

      showInLibrary: (
        id
      ) => {
        set((state) => {
          if (
            !state.libraryHidden.includes(
              id
            )
          ) {
            return state;
          }

          const libraryHidden =
            state.libraryHidden.filter(
              (hidden) =>
                hidden !== id
            );

          const purchased = [
            ...state.purchased,
            id,
          ];

          save(
            "soma_library_hidden",
            libraryHidden
          );

          save(
            "soma_purchased",
            purchased
          );

          return {
            libraryHidden,
            purchased,
          };
        });
      },

      removePurchased: (
        id
      ) => {
        set((state) => {
          /*
           * Unlocks live on the server.
           * Removing only hides the material.
           * Opening it again costs nothing.
           */

          const purchased =
            state.purchased.filter(
              (p) => p !== id
            );

          const libraryHidden = [
            ...new Set([
              ...state.libraryHidden,
              id,
            ]),
          ];

          save(
            "soma_purchased",
            purchased
          );

          save(
            "soma_library_hidden",
            libraryHidden
          );

          return {
            purchased,
            libraryHidden,
          };
        });
      },

      /* =====================================================
         QUIZ RESULTS

         IMPORTANT:
         Quiz activity still gives XP and learning/term points.
         It DOES NOT create SOMA Points or wallet money.
         ===================================================== */

      addQuizResult: (
        result
      ) => {
        const state = get();
        const t = today();

        /* -----------------------------------------------
           STREAK
           ----------------------------------------------- */

        let streak: Streak = {
          ...state.streak,
        };

        const previousStreakCount =
          state.streak.count;

        if (
          streak.lastActiveDate ===
          t
        ) {
          // Already counted today.
        } else if (
          streak.lastActiveDate &&
          daysBetween(
            streak.lastActiveDate,
            t
          ) === 1
        ) {
          streak.count += 1;
        } else {
          streak.count = 1;
        }

        streak.best = Math.max(
          streak.best,
          streak.count
        );

        streak.lastActiveDate =
          t;

        /* -----------------------------------------------
           XP

           Quiz results still earn XP.
           They do NOT earn paid SOMA Points.
           ----------------------------------------------- */

        const xpEarned =
          Math.round(
            result.percentage / 4
          ) +
          (result.type === "exam"
            ? 15
            : 8);

        /*
         * SOMA Points earned from quizzes are now ALWAYS 0.
         *
         * The field remains because existing screens/types
         * may still use it.
         */

        const coinsEarned = 0;

        /* -----------------------------------------------
           NEW QUIZ RESULT
           ----------------------------------------------- */

        const newResult:
          QuizResult = {
            ...result,

            xpEarned,
            coinsEarned,

            id: Math.random()
              .toString(36)
              .slice(2, 9),

            date:
              new Date().toISOString(),
          };

        const quizResults = [
          newResult,
          ...state.quizResults,
        ].slice(0, 200);

        const xp =
          state.xp +
          xpEarned;

        /*
         * Do not create fake reward transactions.
         *
         * Existing transaction history is preserved.
         */

        const transactions =
          state.transactions;

        /* =================================================
           TERM LEARNING POINTS
           ================================================= */

        const {
          year,
          term,
        } =
          getCurrentSchoolTerm();

        const termKey =
          `${year}-T${term}`;

        const existingTerm =
          state.termPoints[
            termKey
          ] ??
          createEmptyTermPoints(
            year,
            term
          );

        const termPoints = {
          ...state.termPoints,
        };

        /* -----------------------------------------------
           TOPICAL / EXAM POINTS
           ----------------------------------------------- */

        const category:
          TermPointCategory =
          result.type === "exam"
            ? "exams"
            : "topicalQuizzes";

        const categoryLimit =
          TERM_POINT_LIMITS[
            category
          ];

        const currentCategory =
          existingTerm[
            category
          ];

        const currentTotal =
          getTermPointsTotal(
            existingTerm
          );

        const availableOverall =
          MAX_TERM_POINTS -
          currentTotal;

        const requestedPoints =
          result.type === "exam"
            ? EXAM_TERM_POINTS
            : TOPICAL_QUIZ_TERM_POINTS;

        const pointsToAdd =
          Math.max(
            0,
            Math.min(
              requestedPoints,
              categoryLimit -
                currentCategory,
              availableOverall
            )
          );

        if (
          pointsToAdd > 0
        ) {
          termPoints[
            termKey
          ] = {
            ...existingTerm,

            [category]:
              currentCategory +
              pointsToAdd,
          };
        } else if (
          !termPoints[
            termKey
          ]
        ) {
          termPoints[
            termKey
          ] = existingTerm;
        }

        /* =================================================
           CONSISTENCY POINTS
           ================================================= */

        const isNewStreakDay =
          streak.lastActiveDate ===
            t &&
          streak.count >
            previousStreakCount;

        if (
          isNewStreakDay
        ) {
          const updatedTerm =
            termPoints[
              termKey
            ] ??
            createEmptyTermPoints(
              year,
              term
            );

          const consistencyAvailable =
            TERM_POINT_LIMITS
              .consistency -
            updatedTerm.consistency;

          const overallAvailable =
            MAX_TERM_POINTS -
            getTermPointsTotal(
              updatedTerm
            );

          const consistencyPoints =
            Math.max(
              0,
              Math.min(
                CONSISTENCY_TERM_POINTS,
                consistencyAvailable,
                overallAvailable
              )
            );

          if (
            consistencyPoints > 0
          ) {
            termPoints[
              termKey
            ] = {
              ...updatedTerm,

              consistency:
                updatedTerm.consistency +
                consistencyPoints,
            };
          }
        }

        /* =================================================
           PROGRESS / IMPROVEMENT POINTS
           ================================================= */

        const previousTermResults =
          state.quizResults.filter(
            (previousResult) => {
              const resultDate =
                new Date(
                  previousResult.date
                );

              const resultTerm =
                getCurrentSchoolTerm(
                  resultDate
                );

              return (
                resultTerm.year ===
                  year &&
                resultTerm.term ===
                  term
              );
            }
          );

        const previousPerformance =
          previousTermResults.length >
          0
            ? previousTermResults[0]
                .percentage
            : null;

        if (
          previousPerformance !==
            null &&
          result.percentage >
            previousPerformance
        ) {
          const improvement =
            result.percentage -
            previousPerformance;

          const progressPointsEarned =
            Math.floor(
              improvement /
                PROGRESS_PERCENTAGE_STEP
            ) *
            PROGRESS_POINTS_PER_STEP;

          if (
            progressPointsEarned > 0
          ) {
            const updatedTerm =
              termPoints[
                termKey
              ] ??
              createEmptyTermPoints(
                year,
                term
              );

            const progressAvailable =
              TERM_POINT_LIMITS
                .progress -
              updatedTerm.progress;

            const overallAvailable =
              MAX_TERM_POINTS -
              getTermPointsTotal(
                updatedTerm
              );

            const progressPoints =
              Math.max(
                0,
                Math.min(
                  progressPointsEarned,
                  progressAvailable,
                  overallAvailable
                )
              );

            if (
              progressPoints > 0
            ) {
              termPoints[
                termKey
              ] = {
                ...updatedTerm,

                progress:
                  updatedTerm.progress +
                  progressPoints,
              };
            }
          }
        }

        /* =================================================
           SAVE EVERYTHING
           ================================================= */

        save(
          "soma_quiz_results",
          quizResults
        );

        save(
          "soma_xp",
          xp
        );

        save(
          "soma_streak",
          streak
        );

        save(
          "soma_transactions",
          transactions
        );

        save(
          "soma_term_points",
          termPoints
        );

        set({
          quizResults,
          xp,
          streak,
          transactions,
          termPoints,
        });

        const latestState =
          get();

        void syncStudentPerformanceToBackend({
          soma_hub_code:
            latestState.somaHubCode,

          term_points:
            Object.values(
              latestState.termPoints
            ),

          quiz_results:
            latestState.quizResults,
        });

        return {
          xpEarned,
          coinsEarned,
          streak,
        };
      },

      /* =====================================================
         QUIZ PROGRESS
         ===================================================== */

      saveQuizProgress: (
        progress
      ) => {
        set((state) => {
          const next = {
            ...state.quizProgress,

            [progress.materialId]: {
              ...progress,
              updatedAt:
                new Date().toISOString(),
            },
          };

          save(
            "soma_quiz_progress",
            next
          );

          return {
            quizProgress: next,
          };
        });
      },

      clearQuizProgress: (
        materialId
      ) => {
        set((state) => {
          if (
            !state.quizProgress[
              materialId
            ]
          ) {
            return state;
          }

          const next = {
            ...state.quizProgress,
          };

          delete next[
            materialId
          ];

          save(
            "soma_quiz_progress",
            next
          );

          return {
            quizProgress: next,
          };
        });
      },

      /* =====================================================
         LOGOUT
         ===================================================== */

      logout: () => {
        KEYS.forEach(
          (key) => {
            try {
              localStorage.removeItem(
                key
              );
            } catch {
              /* noop */
            }
          }
        );

        set({
          name: null,
          avatar: null,
          grade: null,
          schoolName: null,

          somaHubCode:
            generateSomaHubCode(),

          studyIntent: null,
          pathway: null,
          activeGrade: null,

          /*
           * No free starting balance after logout.
           */

          wallet: 0,
          ksh: null,

          prices:
            DEFAULT_PRICES,

          subscription: null,
          xp: 0,

          streak: {
            ...EMPTY_STREAK,
          },

          dailyGoal: 2,
          purchased: [],
          libraryHidden: [],
          transactions: [],
          quizResults: [],
          quizProgress: {},
          termPoints: {},
          studyNotesCompleted: {},
        });
      },
    };
  });

/* =========================================================
   HELPERS
   ========================================================= */

function today(): string {
  const now = new Date();

  const year =
    now.getFullYear();

  const month =
    String(
      now.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      now.getDate()
    ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function daysBetween(
  from: string,
  to: string
): number {
  const fromDate =
    new Date(
      `${from}T00:00:00`
    );

  const toDate =
    new Date(
      `${to}T00:00:00`
    );

  const difference =
    toDate.getTime() -
    fromDate.getTime();

  return Math.round(
    difference /
      (1000 * 60 * 60 * 24)
  );
}

/* =========================================================
   INITIAL STUDENT BACKEND SYNC
   ========================================================= */

setTimeout(() => {
  const state =
    useSomaStore.getState();

  if (!state.name) {
    return;
  }

  /*
   * IMPORTANT:
   * Register the student first.
   *
   * The performance endpoint needs the student to already
   * exist in the backend before term points and quiz results
   * are synchronized.
   */
  void (async () => {
    await syncStudentToBackend({
      soma_hub_code:
        state.somaHubCode,

      name:
        state.name!,

      school_name:
        state.schoolName ?? "",

      grade:
        state.grade ?? "",
    });

    await syncStudentPerformanceToBackend({
      soma_hub_code:
        state.somaHubCode,

      term_points:
        Object.values(
          state.termPoints
        ),

      quiz_results:
        state.quizResults,
    });
  })();
}, 0);