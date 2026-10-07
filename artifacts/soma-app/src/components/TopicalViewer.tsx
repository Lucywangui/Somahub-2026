import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { Material } from "@/data/materials";
import {
  getQuestionsForMaterial,
  type Question,
} from "@/data/questions";

import { useSomaStore } from "@/lib/storage";

import { Button } from "@/components/ui/button";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";

import { Label } from "@/components/ui/label";

import {
  X,
  BookOpen,
} from "lucide-react";

import { TopicNotesOverlay } from "./TopicNotesOverlay";

interface Props {
  material: Material;
  onClose: () => void;
}

const TOTAL_QUESTIONS = 15;

export function TopicalViewer({
  material,
  onClose,
}: Props) {
  const addQuizResult = useSomaStore(
    (s) => s.addQuizResult
  );

  const saveQuizProgress = useSomaStore(
    (s) => s.saveQuizProgress
  );

  const clearQuizProgress = useSomaStore(
    (s) => s.clearQuizProgress
  );

  // Resume an in-progress attempt if one exists,
  // otherwise build a fresh set.
  const [questions] = useState<Question[]>(() => {
    const p =
      useSomaStore.getState().quizProgress[
        material.id
      ];

    if (
      p &&
      p.type === "topical" &&
      p.questions.length
    ) {
      return p.questions;
    }

    return getQuestionsForMaterial(
      material,
      TOTAL_QUESTIONS,
      Date.now()
    );
  });

  const resumed =
    useSomaStore.getState().quizProgress[
      material.id
    ];

  const [currentIndex, setCurrentIndex] =
    useState(
      resumed?.type === "topical"
        ? Math.min(
            resumed.currentIndex,
            questions.length - 1
          )
        : 0
    );

  const [selectedOption, setSelectedOption] =
    useState<string>("");

  const [hasChecked, setHasChecked] =
    useState(false);

  const [score, setScore] =
    useState(
      resumed?.type === "topical"
        ? resumed.score
        : 0
    );

  const [isFinished, setIsFinished] =
    useState(false);

  const [resultSaved, setResultSaved] =
    useState(false);

  const [reward, setReward] = useState<{
    xpEarned: number;
    streak: number;
  } | null>(null);

  const [notesOpen, setNotesOpen] =
    useState(false);

  const currentQ =
    questions[currentIndex];

  const answeredWrong =
    hasChecked &&
    !!currentQ &&
    parseInt(selectedOption) !==
      currentQ.correct;

  // Persist progress so the learner can leave
  // and come back.
  useEffect(() => {
    if (isFinished) return;

    if (
      currentIndex === 0 &&
      !hasChecked &&
      !resumed
    ) {
      return;
    }

    saveQuizProgress({
      materialId: material.id,
      type: "topical",
      questions,
      answers: {},
      currentIndex,
      score,
      startedAt:
        resumed?.startedAt ??
        new Date().toISOString(),
      updatedAt:
        new Date().toISOString(),
    });
  }, [
    currentIndex,
    score,
    hasChecked,
    isFinished,
  ]);

  const handleCheck = () => {
    if (!selectedOption || !currentQ) {
      return;
    }

    setHasChecked(true);

    if (
      parseInt(selectedOption) ===
      currentQ.correct
    ) {
      setScore((s) => s + 1);
    }
  };

  const handleNext = () => {
    if (
      currentIndex <
      questions.length - 1
    ) {
      setCurrentIndex(
        (i) => i + 1
      );

      setSelectedOption("");

      setHasChecked(false);
    } else {
      setIsFinished(true);
    }
  };

  useEffect(() => {
    if (
      isFinished &&
      !resultSaved &&
      questions.length > 0
    ) {
      const pct = Math.round(
        (score / questions.length) * 100
      );

      const r = addQuizResult({
        materialId: material.id,
        materialTitle: material.title,
        subject: material.subject,
        gradeKey: material.gradeKey,
        topics: material.topics,
        type: "topical",
        score,
        total: questions.length,
        percentage: pct,
      });

      // IMPORTANT:
      // Quiz completion does NOT award SOMA Points.
      // addQuizResult() still handles XP, streaks,
      // term performance points, and quiz history.

      setReward({
        xpEarned: r.xpEarned,
        streak: r.streak.count,
      });

      clearQuizProgress(
        material.id
      );

      setResultSaved(true);
    }
  }, [isFinished]);

  // ============================================================
  // FINISHED SCREEN
  // ============================================================
  //
  // IMPORTANT FIX:
  // When notesOpen is true, this screen is not rendered.
  // The Study Notes overlay becomes the active view instead.
  // ============================================================

  if (
    isFinished &&
    !notesOpen
  ) {
    const percentage =
      Math.round(
        (score / questions.length) * 100
      );

    const emoji =
      percentage >= 80
        ? "🏆"
        : percentage >= 60
          ? "🌟"
          : percentage >= 40
            ? "👍"
            : "📚";

    const message =
      percentage >= 80
        ? "Outstanding! Keep it up!"
        : percentage >= 60
          ? "Great work! Almost there!"
          : percentage >= 40
            ? "Good effort! Keep practising!"
            : "Don't give up! Try again!";

    return (
      <>
        <motion.div
          className="
            flex
            flex-col
            items-center
            justify-center
            min-h-full
            p-8
            rounded-xl
            text-white
            relative
            z-10
          "
          style={{
            background:
              "linear-gradient(135deg, #1a3a5c, #1e5799)",
          }}
          initial={{
            opacity: 0,
            scale: 0.9,
          }}
          animate={{
            opacity: 1,
            scale: 1,
          }}
          transition={{
            duration: 0.4,
          }}
        >
          <motion.div
            className="text-8xl mb-4"
            animate={{
              rotate: [
                0,
                -10,
                10,
                -10,
                0,
              ],
              scale: [
                1,
                1.2,
                1,
              ],
            }}
            transition={{
              duration: 0.8,
              delay: 0.3,
            }}
          >
            {emoji}
          </motion.div>

          <h2
            className="
              text-3xl
              font-extrabold
              mb-2
            "
          >
            Quiz Complete!
          </h2>

          <p
            className="
              text-lg
              opacity-70
              mb-1
            "
          >
            {material.subject}
          </p>

          <div
            className="
              flex
              flex-wrap
              justify-center
              gap-2
              mb-6
            "
          >
            {material.topics.map(
              (t, i) => (
                <span
                  key={i}
                  className="
                    text-xs
                    px-2
                    py-0.5
                    rounded-full
                    font-semibold
                  "
                  style={{
                    background:
                      "rgba(255,255,255,0.15)",
                  }}
                >
                  {t}
                </span>
              )
            )}
          </div>

          <div
            className="
              w-36
              h-36
              rounded-full
              flex
              flex-col
              items-center
              justify-center
              mb-6
              shadow-xl
            "
            style={{
              background:
                "rgba(255,255,255,0.12)",
              border:
                "4px solid rgba(255,255,255,0.3)",
            }}
          >
            <span
              className="
                text-4xl
                font-extrabold
              "
            >
              {percentage}%
            </span>

            <span
              className="
                text-sm
                opacity-70
                mt-1
              "
            >
              {score}/{questions.length}
            </span>
          </div>

          <p
            className="
              text-xl
              font-semibold
              mb-2
            "
            style={{
              color: "#e67e22",
            }}
          >
            {message}
          </p>

          <div
            className="
              px-6
              py-2
              rounded-full
              text-sm
              font-bold
              mb-4
            "
            style={{
              background:
                percentage >= 80
                  ? "#27ae60"
                  : percentage >= 60
                    ? "#e67e22"
                    : percentage >= 40
                      ? "#2980b9"
                      : "#e74c3c",
            }}
          >
            {percentage >= 80
              ? "EXCELLENT"
              : percentage >= 60
                ? "GOOD"
                : percentage >= 40
                  ? "FAIR"
                  : "NEEDS WORK"}
          </div>

          {reward && (
            <motion.div
              className="
                flex
                gap-3
                mb-6
              "
              initial={{
                opacity: 0,
                y: 8,
              }}
              animate={{
                opacity: 1,
                y: 0,
              }}
              transition={{
                delay: 0.4,
              }}
            >
              <span
                className="
                  px-3
                  py-1.5
                  rounded-full
                  text-sm
                  font-bold
                "
                style={{
                  background:
                    "rgba(255,255,255,0.15)",
                }}
              >
                +{reward.xpEarned} XP
              </span>

              {reward.streak > 1 && (
                <span
                  className="
                    px-3
                    py-1.5
                    rounded-full
                    text-sm
                    font-bold
                  "
                  style={{
                    background:
                      "rgba(255,255,255,0.15)",
                  }}
                >
                  🔥 {reward.streak}-day streak
                </span>
              )}
            </motion.div>
          )}

          <div
            className="
              w-full
              max-w-xs
              mb-8
            "
          >
            <div
              className="
                h-3
                rounded-full
                bg-white/20
                overflow-hidden
              "
            >
              <motion.div
                className="
                  h-full
                  rounded-full
                "
                style={{
                  background:
                    percentage >= 80
                      ? "#27ae60"
                      : percentage >= 60
                        ? "#e67e22"
                        : percentage >= 40
                          ? "#2980b9"
                          : "#e74c3c",
                }}
                initial={{
                  width: 0,
                }}
                animate={{
                  width:
                    `${percentage}%`,
                }}
                transition={{
                  duration: 0.8,
                  delay: 0.5,
                }}
              />
            </div>
          </div>

          <div
            className="
              flex
              flex-col
              sm:flex-row
              gap-3
            "
          >
            {score < questions.length && (
              <Button
                size="lg"
                variant="outline"
                className="
                  px-8
                  py-6
                  text-lg
                  rounded-full
                  border-2
                  border-white/40
                  bg-transparent
                  text-white
                  hover:bg-white/10
                "
                onClick={() =>
                  setNotesOpen(true)
                }
              >
                📖 Review the notes
              </Button>
            )}

            <Button
              size="lg"
              className="
                px-12
                py-6
                text-xl
                rounded-full
                border-0
                font-bold
              "
              style={{
                background: "#e67e22",
                color: "#fff",
              }}
              onClick={onClose}
            >
              Back to Dashboard
            </Button>
          </div>
        </motion.div>
      </>
    );
  }

  // ============================================================
  // STUDY NOTES AFTER FINISHING
  // ============================================================
  //
  // This remains unchanged.
  // Once Review the notes is clicked:
  //
  // isFinished = true
  // notesOpen = true
  //
  // Therefore the finished screen above is skipped and
  // TopicNotesOverlay becomes the active view.
  // ============================================================

  if (
    isFinished &&
    notesOpen
  ) {
    return (
      <TopicNotesOverlay
        material={material}
        onClose={() =>
          setNotesOpen(false)
        }
      />
    );
  }

  if (!currentQ) {
    return null;
  }

  const progress =
    (
      (
        currentIndex +
        (hasChecked ? 1 : 0)
      ) /
      questions.length
    ) *
    100;

  // ============================================================
  // ACTIVE QUIZ
  // ============================================================

  return (
    <div
      className="
        flex
        flex-col
        min-h-full
        bg-card
        rounded-xl
        shadow-2xl
        overflow-hidden
        max-w-4xl
        mx-auto
        mt-4
        mb-4
        border
      "
    >
      {/* Header */}

      <div
        className="
          text-primary-foreground
          p-4
          flex
          justify-between
          items-center
        "
        style={{
          background:
            "linear-gradient(90deg, #1a3a5c, #1e5799)",
        }}
      >
        <div>
          <h2
            className="
              font-bold
              text-xl
              text-white
            "
          >
            {material.subject}
          </h2>

          <div
            className="
              flex
              flex-wrap
              gap-1
              mt-0.5
            "
          >
            {material.topics.map(
              (t, i) => (
                <span
                  key={i}
                  className="
                    text-xs
                    text-white/60
                    font-medium
                  "
                >
                  {i > 0 ? "· " : ""}
                  {t}
                </span>
              )
            )}
          </div>

          <div
            className="
              text-sm
              text-white/70
              mt-1
            "
          >
            Question {currentIndex + 1} of{" "}
            {questions.length}
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="
            text-white
            hover:bg-white/20
          "
        >
          <X className="h-6 w-6" />
        </Button>
      </div>

      {/* Progress bar */}

      <div
        className="
          h-1.5
          bg-muted
        "
      >
        <motion.div
          className="h-full"
          style={{
            background: "#e67e22",
          }}
          animate={{
            width: `${progress}%`,
          }}
          transition={{
            duration: 0.3,
          }}
        />
      </div>

      <div
        className="
          p-8
          flex-1
          flex
          flex-col
        "
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={currentIndex}
            initial={{
              opacity: 0,
              x: 30,
            }}
            animate={{
              opacity: 1,
              x: 0,
            }}
            exit={{
              opacity: 0,
              x: -30,
            }}
            transition={{
              duration: 0.25,
            }}
          >
            <div
              className="
                text-2xl
                font-medium
                mb-10
                leading-relaxed
              "
            >
              {currentQ.text}
            </div>

            <RadioGroup
              value={selectedOption}
              onValueChange={
                setSelectedOption
              }
              disabled={hasChecked}
              className="space-y-4"
            >
              {currentQ.options.map(
                (opt, i) => (
                  <div
                    key={i}
                    className={`
                      flex
                      items-center
                      space-x-3
                      p-4
                      rounded-xl
                      border-2
                      transition-all
                      ${
                        hasChecked &&
                        i === currentQ.correct
                          ? "border-green-500 bg-green-50 text-green-900"
                          : hasChecked &&
                              selectedOption ===
                                i.toString() &&
                              i !==
                                currentQ.correct
                            ? "border-red-500 bg-red-50 text-red-900"
                            : "border-muted hover:border-primary/50"
                      }
                    `}
                  >
                    <RadioGroupItem
                      value={i.toString()}
                      id={`opt-${i}`}
                      className="
                        w-5
                        h-5
                      "
                    />

                    <Label
                      htmlFor={`opt-${i}`}
                      className="
                        flex-1
                        text-lg
                        cursor-pointer
                        leading-snug
                      "
                    >
                      {opt}
                    </Label>

                    {hasChecked &&
                      i ===
                        currentQ.correct && (
                        <span
                          className="
                            text-green-600
                            font-bold
                            text-xl
                          "
                        >
                          ✓
                        </span>
                      )}

                    {hasChecked &&
                      selectedOption ===
                        i.toString() &&
                      i !==
                        currentQ.correct && (
                        <span
                          className="
                            text-red-600
                            font-bold
                            text-xl
                          "
                        >
                          ✗
                        </span>
                      )}
                  </div>
                )
              )}
            </RadioGroup>
          </motion.div>
        </AnimatePresence>

        {hasChecked &&
          (
            currentQ.explanation ||
            answeredWrong
          ) && (
            <motion.div
              initial={{
                opacity: 0,
                height: 0,
              }}
              animate={{
                opacity: 1,
                height: "auto",
              }}
              className="
                mt-6
                rounded-xl
                border-l-4
                border-primary
                bg-muted/50
                p-4
                text-[15px]
                leading-relaxed
              "
            >
              {currentQ.explanation && (
                <p>
                  <span
                    className="
                      font-bold
                      text-primary
                    "
                  >
                    Why:{" "}
                  </span>

                  {currentQ.explanation}
                </p>
              )}

              {answeredWrong && (
                <Button
                  variant="outline"
                  size="sm"
                  className="
                    mt-3
                    gap-2
                    border-primary/40
                    text-primary
                    hover:bg-primary/5
                  "
                  onClick={() =>
                    setNotesOpen(true)
                  }
                >
                  <BookOpen className="h-4 w-4" />

                  Learn more about this topic
                </Button>
              )}
            </motion.div>
          )}

        <div
          className="
            mt-auto
            pt-8
            flex
            justify-between
            items-center
            gap-4
          "
        >
          <div
            className="
              text-xl
              font-bold
            "
          >
            {hasChecked &&
              (
                parseInt(
                  selectedOption
                ) ===
                  currentQ.correct
                  ? (
                    <span
                      className="
                        text-green-600
                      "
                    >
                      ✅ CORRECT!
                    </span>
                  )
                  : (
                    <span
                      className="
                        text-red-600
                        text-base
                      "
                    >
                      ❌ Answer:{" "}
                      {
                        currentQ.options[
                          currentQ.correct
                        ]
                      }
                    </span>
                  )
              )}
          </div>

          {!hasChecked ? (
            <Button
              size="lg"
              className="
                text-lg
                px-10
                py-6
                rounded-full
              "
              disabled={!selectedOption}
              onClick={handleCheck}
            >
              CHECK ANSWER
            </Button>
          ) : (
            <Button
              size="lg"
              className="
                text-lg
                px-10
                py-6
                rounded-full
                text-white
                border-0
              "
              style={{
                background: "#e67e22",
              }}
              onClick={handleNext}
            >
              {currentIndex <
              questions.length - 1
                ? "NEXT ➔"
                : "SEE RESULTS"}
            </Button>
          )}
        </div>
      </div>

      {/* Study notes while answering */}

      {notesOpen && (
        <TopicNotesOverlay
          material={material}
          onClose={() =>
            setNotesOpen(false)
          }
        />
      )}
    </div>
  );
}