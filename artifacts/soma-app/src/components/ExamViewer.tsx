import { useState, useEffect, useRef } from "react";

import { Material } from "@/data/materials";
import {
  getQuestionsForMaterial,
  type Question,
} from "@/data/questions";

import { resolveGrade } from "@/data/grade";
import {
  targetExamFor,
  performanceLevel,
  kcseGrade,
} from "@/data/assessment";

import { useSomaStore } from "@/lib/storage";

import { Button } from "@/components/ui/button";

import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";

import { Label } from "@/components/ui/label";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  AlertTriangle,
  Clock,
  BookOpen,
} from "lucide-react";

import { TopicNotesOverlay } from "./TopicNotesOverlay";

interface Props {
  material: Material;
  onClose: () => void;
}

const TOTAL_QUESTIONS = 15;
const TOTAL_MARKS = 100;

const EXAM_MINUTES: Record<string, number> = {
  senior: 40,
  junior: 30,
  upper: 25,
  lower: 20,
};

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function ExamViewer({
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

  const resolved = resolveGrade(
    material.gradeKey
  );

  const band = resolved.band;

  const exam = targetExamFor(
    material.gradeKey
  );

  // Senior candidates sit under real exam
  // conditions: a countdown that auto-submits.
  const timed = band === "senior";

  const limitSeconds =
    (EXAM_MINUTES[band] ?? 30) * 60;

  // Resume an in-progress paper if one exists,
  // otherwise build a fresh one.
  const [questions] =
    useState<Question[]>(() => {
      const p =
        useSomaStore.getState().quizProgress[
          material.id
        ];

      if (
        p &&
        p.type === "exam" &&
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

  const [answers, setAnswers] =
    useState<Record<number, string>>(
      resumed?.type === "exam"
        ? resumed.answers
        : {}
    );

  const [showResults, setShowResults] =
    useState(false);

  const [isSubmitted, setIsSubmitted] =
    useState(false);

  const [
    showIncompleteWarning,
    setShowIncompleteWarning,
  ] = useState(false);

  const [reward, setReward] = useState<{
    xpEarned: number;
    streak: number;
  } | null>(null);

  const [notesOpen, setNotesOpen] =
    useState(false);

  const [remaining, setRemaining] =
    useState(limitSeconds);

  const submitRef =
    useRef<() => void>(() => {});

  // Persist answers so the learner can leave
  // and resume the paper — only once at least
  // one answer is given.
  useEffect(() => {
    if (isSubmitted) return;

    if (
      Object.keys(answers).length === 0 &&
      !resumed
    ) {
      return;
    }

    saveQuizProgress({
      materialId: material.id,
      type: "exam",
      questions,
      answers,
      currentIndex: 0,
      score: 0,
      startedAt:
        resumed?.startedAt ??
        new Date().toISOString(),
      updatedAt:
        new Date().toISOString(),
    });
  }, [
    answers,
    isSubmitted,
  ]);

  const unanswered =
    questions.filter(
      (_, i) => !answers[i]
    ).length;

  const correctCount =
    questions.filter(
      (q, i) =>
        answers[i] ===
        q.correct.toString()
    ).length;

  const score = Math.round(
    (correctCount / TOTAL_QUESTIONS) *
      TOTAL_MARKS
  );

  const percentage = score;

  const isCbe =
    resolved.curriculum === "cbc";

  const pLevel =
    performanceLevel(percentage);

  const kcse =
    kcseGrade(percentage);

  const doSubmit = () => {
    if (isSubmitted) return;

    const r = addQuizResult({
      materialId: material.id,
      materialTitle: material.title,
      subject: material.subject,
      gradeKey: material.gradeKey,
      topics: material.topics,
      type: "exam",
      score,
      total: TOTAL_MARKS,
      percentage,
    });

    // IMPORTANT:
    // Exams do NOT award SOMA Points.
    //
    // addQuizResult() still handles XP,
    // streaks, exam history and term
    // performance points.

    setReward({
      xpEarned: r.xpEarned,
      streak: r.streak.count,
    });

    clearQuizProgress(
      material.id
    );

    setIsSubmitted(true);
    setShowResults(true);
    setShowIncompleteWarning(false);
  };

  submitRef.current = doSubmit;

  // Countdown for timed senior papers —
  // auto-submits at zero.
  useEffect(() => {
    if (!timed || isSubmitted) {
      return;
    }

    const id = setInterval(() => {
      setRemaining((s) => {
        if (s <= 1) {
          clearInterval(id);
          submitRef.current();
          return 0;
        }

        return s - 1;
      });
    }, 1000);

    return () =>
      clearInterval(id);
  }, [
    timed,
    isSubmitted,
  ]);

  const handleSubmitClick = () => {
    if (unanswered > 0) {
      setShowIncompleteWarning(true);
    } else {
      doSubmit();
    }
  };

  return (
    <div
      className="
        bg-white
        min-h-full
        text-black
        p-6
        font-serif
        print:p-0
        relative
      "
    >
      {timed && !isSubmitted && (
        <div
          className={`
            sticky
            top-0
            z-30
            -mx-6
            -mt-6
            mb-4
            px-6
            py-2.5
            flex
            items-center
            justify-between
            font-sans
            text-white
            ${
              remaining <= 300
                ? "bg-red-600"
                : "bg-[#1a3a5c]"
            }
          `}
        >
          <span
            className="
              flex
              items-center
              gap-2
              text-sm
              font-semibold
            "
          >
            <Clock className="h-4 w-4" />

            Exam conditions —
            auto-submits at 0:00
          </span>

          <span
            className="
              text-lg
              font-bold
              tabular-nums
            "
          >
            {fmtClock(remaining)}
          </span>
        </div>
      )}

      <div
        className="
          max-w-4xl
          mx-auto
          border-2
          border-black
          p-8
          shadow-sm
        "
      >
        {/* Header */}

        <div
          className="
            text-center
            border-b-2
            border-black
            pb-6
            mb-8
          "
        >
          <h1
            className="
              text-3xl
              font-bold
              uppercase
              mb-2
            "
          >
            {material.title}
          </h1>

          <h2
            className="
              text-sm
              font-bold
              mb-1
              font-sans
              text-gray-500
            "
          >
            {exam
              ? `${exam.code}-style · ${resolved.levelName}`
              : resolved.levelName}

            {timed && (
              <span className="text-red-700">
                {" "}
                · EXAM CONDITIONS
              </span>
            )}
          </h2>

          {/* Topic badges */}

          <div
            className="
              flex
              flex-wrap
              justify-center
              gap-2
              mt-2
              mb-3
            "
          >
            {material.topics
              .slice(0, 5)
              .map((t, i) => (
                <span
                  key={i}
                  className="
                    text-xs
                    px-3
                    py-1
                    rounded-full
                    font-sans
                    font-semibold
                  "
                  style={{
                    background: "#f0f4ff",
                    color: "#1a3a5c",
                  }}
                >
                  {t}
                </span>
              ))}
          </div>

          <p
            className="
              text-sm
              font-sans
              text-gray-600
              mb-4
            "
          >
            {TOTAL_QUESTIONS} Questions ·{" "}
            {TOTAL_MARKS} Marks · Time:{" "}
            {EXAM_MINUTES[band] ?? 30} minutes

            {timed && (
              <span
                className="
                  block
                  text-red-600
                  font-semibold
                  mt-1
                "
              >
                This paper is timed and will
                submit automatically when the
                clock reaches zero.
              </span>
            )}
          </p>

          {isSubmitted ? (
            <div
              className="
                inline-block
                bg-green-100
                border-2
                border-green-600
                px-4
                py-2
                text-green-800
                font-bold
                text-sm
                font-sans
              "
            >
              ✅ Review your answers —
              the correct one is marked for
              each question
            </div>
          ) : (
            <div
              className="
                grid
                grid-cols-2
                gap-4
                text-left
                font-sans
                text-sm
                mt-6
                border
                border-black
                p-4
              "
            >
              <div>
                <span className="font-bold">
                  STUDENT NAME:{" "}
                </span>

                <div
                  className="
                    border-b
                    border-dashed
                    border-black
                    h-6
                    w-full
                    mt-1
                  "
                />
              </div>

              <div>
                <span className="font-bold">
                  DATE:{" "}
                </span>

                <div
                  className="
                    border-b
                    border-dashed
                    border-black
                    h-6
                    w-full
                    mt-1
                  "
                />
              </div>

              <div>
                <span className="font-bold">
                  SCHOOL:{" "}
                </span>

                <div
                  className="
                    border-b
                    border-dashed
                    border-black
                    h-6
                    w-full
                    mt-1
                  "
                />
              </div>

              <div>
                <span className="font-bold">
                  ADMISSION NO:{" "}
                </span>

                <div
                  className="
                    border-b
                    border-dashed
                    border-black
                    h-6
                    w-full
                    mt-1
                  "
                />
              </div>
            </div>
          )}
        </div>

        {/* Instructions */}

        {!isSubmitted && (
          <div
            className="
              border
              border-gray-300
              p-4
              mb-8
              font-sans
              text-sm
              bg-gray-50
            "
          >
            <p className="font-bold mb-1">
              INSTRUCTIONS TO CANDIDATES:
            </p>

            <ol
              className="
                list-decimal
                ml-5
                space-y-1
                text-gray-700
              "
            >
              <li>
                Answer ALL{" "}
                {TOTAL_QUESTIONS} questions.
              </li>

              <li>
                Each question carries equal
                marks. Total: {TOTAL_MARKS}{" "}
                marks.
              </li>

              <li>
                Choose only ONE answer per
                question.
              </li>

              <li>
                Do not leave any question
                blank.
              </li>
            </ol>

            {unanswered > 0 && (
              <p
                className="
                  mt-2
                  text-amber-600
                  font-semibold
                "
              >
                ⚠ {unanswered} question
                {unanswered !== 1
                  ? "s"
                  : ""}{" "}
                not yet answered.
              </p>
            )}
          </div>
        )}

        {/* All 15 questions — single section */}

        <div className="space-y-8">
          {questions.map((q, i) => {
            const selected =
              answers[i];

            const isCorrect =
              selected ===
              q.correct.toString();

            return (
              <div
                key={i}
                className="break-inside-avoid"
              >
                <div className="flex gap-3">
                  <span
                    className="
                      font-bold
                      shrink-0
                      text-base
                    "
                  >
                    {i + 1}.
                  </span>

                  <div className="flex-1">
                    <p
                      className="
                        mb-3
                        text-base
                        leading-relaxed
                      "
                    >
                      {q.text}
                    </p>

                    <RadioGroup
                      value={
                        selected || ""
                      }
                      onValueChange={(v) =>
                        !isSubmitted &&
                        setAnswers(
                          (prev) => ({
                            ...prev,
                            [i]: v,
                          })
                        )
                      }
                      className="
                        space-y-2
                        ml-2
                      "
                    >
                      {q.options.map(
                        (
                          opt,
                          optIdx
                        ) => {
                          const isThisCorrect =
                            optIdx ===
                            q.correct;

                          const isThisSelected =
                            selected ===
                            optIdx.toString();

                          let rowStyle = "";

                          if (
                            isSubmitted
                          ) {
                            if (
                              isThisCorrect
                            ) {
                              rowStyle =
                                "bg-green-50 border-l-4 border-green-500 rounded-r";
                            } else if (
                              isThisSelected &&
                              !isCorrect
                            ) {
                              rowStyle =
                                "bg-red-50 border-l-4 border-red-400 rounded-r";
                            }
                          }

                          return (
                            <div
                              key={
                                optIdx
                              }
                              className={`
                                flex
                                items-center
                                gap-2
                                px-2
                                py-1
                                transition-colors
                                font-sans
                                ${rowStyle}
                              `}
                            >
                              <RadioGroupItem
                                value={optIdx.toString()}
                                id={`q${i}-o${optIdx}`}
                                disabled={
                                  isSubmitted
                                }
                              />

                              <Label
                                htmlFor={`q${i}-o${optIdx}`}
                                className={`
                                  cursor-pointer
                                  flex-1
                                  font-normal
                                  text-sm
                                  ${
                                    isThisCorrect &&
                                    isSubmitted
                                      ? "text-green-800 font-semibold"
                                      : ""
                                  }
                                `}
                              >
                                {String.fromCharCode(
                                  65 +
                                    optIdx
                                )}
                                . {opt}
                              </Label>

                              {isSubmitted &&
                                isThisCorrect && (
                                  <span
                                    className="
                                      text-green-600
                                      font-bold
                                      text-xs
                                      shrink-0
                                    "
                                  >
                                    ✓ CORRECT
                                  </span>
                                )}

                              {isSubmitted &&
                                isThisSelected &&
                                !isThisCorrect && (
                                  <span
                                    className="
                                      text-red-500
                                      font-bold
                                      text-xs
                                      shrink-0
                                    "
                                  >
                                    ✗ WRONG
                                  </span>
                                )}
                            </div>
                          );
                        }
                      )}
                    </RadioGroup>

                    {isSubmitted &&
                      !isCorrect && (
                        <p
                          className="
                            mt-2
                            ml-2
                            text-xs
                            text-green-700
                            font-sans
                            bg-green-50
                            border
                            border-green-200
                            px-2
                            py-1
                            rounded
                          "
                        >
                          ✓ Correct:{" "}
                          <strong>
                            {String.fromCharCode(
                              65 +
                                q.correct
                            )}
                            .{" "}
                            {
                              q.options[
                                q.correct
                              ]
                            }
                          </strong>
                        </p>
                      )}

                    {isSubmitted &&
                      !selected && (
                        <p
                          className="
                            mt-2
                            ml-2
                            text-xs
                            text-gray-400
                            font-sans
                            italic
                          "
                        >
                          Not attempted —
                          answer:{" "}
                          {String.fromCharCode(
                            65 +
                              q.correct
                          )}
                          .{" "}
                          {
                            q.options[
                              q.correct
                            ]
                          }
                        </p>
                      )}

                    {isSubmitted &&
                      q.explanation && (
                        <p
                          className="
                            mt-1
                            ml-2
                            text-xs
                            text-gray-600
                            font-sans
                            bg-blue-50
                            border
                            border-blue-200
                            px-2
                            py-1
                            rounded
                          "
                        >
                          <strong>
                            Why:{" "}
                          </strong>

                          {q.explanation}
                        </p>
                      )}

                    {isSubmitted &&
                      !isCorrect && (
                        <button
                          className="
                            mt-1.5
                            ml-2
                            inline-flex
                            items-center
                            gap-1.5
                            text-xs
                            font-semibold
                            font-sans
                            text-[#1a3a5c]
                            underline
                            hover:no-underline
                          "
                          onClick={() =>
                            setNotesOpen(
                              true
                            )
                          }
                        >
                          <BookOpen className="h-3.5 w-3.5" />

                          Learn more about
                          this topic
                        </button>
                      )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Submit / Exit */}

        <div
          className="
            text-center
            pt-10
            print:hidden
            space-y-2
          "
        >
          {!isSubmitted ? (
            <>
              <Button
                size="lg"
                className="
                  px-16
                  py-6
                  text-xl
                  rounded-none
                  border-2
                  border-black
                  font-bold
                  uppercase
                  hover:bg-black
                  hover:text-white
                "
                onClick={
                  handleSubmitClick
                }
              >
                SUBMIT EXAM
              </Button>

              {unanswered > 0 && (
                <p
                  className="
                    text-sm
                    text-gray-400
                    font-sans
                  "
                >
                  {unanswered} question
                  {unanswered !== 1
                    ? "s"
                    : ""}{" "}
                  unanswered
                </p>
              )}
            </>
          ) : (
            <Button
              size="lg"
              className="
                px-16
                py-6
                text-xl
                rounded-none
                bg-black
                text-white
                hover:bg-gray-800
                font-bold
              "
              onClick={onClose}
            >
              Exit to Dashboard
            </Button>
          )}
        </div>
      </div>

      {/* Results dialog */}

      <Dialog
        open={showResults}
        onOpenChange={() => {}}
      >
        <DialogContent
          className="
            sm:max-w-md
            bg-white
            border-2
            border-black
            rounded-none
            shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]
          "
        >
          <DialogHeader
            className="
              border-b-2
              border-black
              pb-4
              mb-4
            "
          >
            <DialogTitle
              className="
                text-2xl
                font-bold
                uppercase
                text-center
                font-serif
              "
            >
              Examination Results
            </DialogTitle>
          </DialogHeader>

          <div
            className="
              flex
              flex-col
              items-center
              py-4
              font-sans
            "
          >
            {isCbe &&
            exam?.scale ===
              "performance-level" ? (
              <>
                <div
                  className="
                    text-5xl
                    font-extrabold
                    mb-1
                    font-serif
                  "
                  style={{
                    color:
                      pLevel.color,
                  }}
                >
                  {pLevel.short}
                </div>

                <div
                  className="
                    text-lg
                    font-bold
                    mb-1
                  "
                  style={{
                    color:
                      pLevel.color,
                  }}
                >
                  {pLevel.label}
                </div>

                <div
                  className="
                    text-sm
                    mb-5
                    text-gray-500
                  "
                >
                  {correctCount}/
                  {TOTAL_QUESTIONS}{" "}
                  correct ·{" "}
                  {percentage}%
                </div>
              </>
            ) : (
              <>
                <div
                  className="
                    text-7xl
                    font-bold
                    mb-1
                    font-serif
                  "
                >
                  {kcse.grade}
                </div>

                <div
                  className="
                    text-base
                    font-bold
                    mb-1
                    text-gray-600
                  "
                >
                  {kcse.points}{" "}
                  points
                </div>

                <div
                  className="
                    text-sm
                    mb-5
                    text-gray-500
                  "
                >
                  {score}/
                  {TOTAL_MARKS} ·{" "}
                  {percentage}%
                </div>
              </>
            )}

            <div
              className="
                w-full
                text-sm
                border
                border-gray-200
                rounded
                p-4
                mb-6
                space-y-2
                bg-gray-50
              "
            >
              <p
                className="
                  font-bold
                  text-base
                  mb-1
                "
              >
                Result breakdown
              </p>

              <div
                className="
                  flex
                  justify-between
                "
              >
                <span>
                  Correct answers:
                </span>

                <span className="font-bold">
                  {correctCount} /{" "}
                  {TOTAL_QUESTIONS}
                </span>
              </div>

              {exam && (
                <div
                  className="
                    flex
                    justify-between
                    text-xs
                    text-gray-500
                  "
                >
                  <span>
                    Assessment:
                  </span>

                  <span>
                    {exam.code}-style (
                    {
                      resolved.levelName
                    }
                    )
                  </span>
                </div>
              )}

              <p
                className="
                  text-xs
                  text-green-600
                  pt-1
                "
              >
                ✅ Saved — this counts
                toward your{" "}
                {exam?.code ?? "exam"}{" "}
                progress.
              </p>
            </div>

            {reward && (
              <div
                className="
                  flex
                  gap-2
                  mb-4
                  text-xs
                  font-bold
                "
              >
                <span
                  className="
                    px-2.5
                    py-1
                    rounded
                    bg-gray-100
                    border
                    border-gray-300
                  "
                >
                  +{reward.xpEarned} XP
                </span>

                {reward.streak > 1 && (
                  <span
                    className="
                      px-2.5
                      py-1
                      rounded
                      bg-gray-100
                      border
                      border-gray-300
                    "
                  >
                    🔥{" "}
                    {reward.streak}{" "}
                    days
                  </span>
                )}
              </div>
            )}

            <div
              className="
                flex
                gap-4
                w-full
              "
            >
              <Button
                onClick={() =>
                  setShowResults(false)
                }
                variant="outline"
                className="
                  flex-1
                  rounded-none
                  border-black
                  hover:bg-gray-100
                "
              >
                Review Answers
              </Button>

              <Button
                onClick={onClose}
                className="
                  flex-1
                  rounded-none
                  bg-black
                  text-white
                  hover:bg-gray-800
                "
              >
                Exit
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Incomplete warning */}

      <Dialog
        open={showIncompleteWarning}
        onOpenChange={
          setShowIncompleteWarning
        }
      >
        <DialogContent
          className="
            sm:max-w-sm
            bg-white
            border-2
            border-amber-400
            rounded-none
          "
        >
          <DialogHeader className="pb-3">
            <DialogTitle
              className="
                flex
                items-center
                gap-2
                text-amber-700
                font-sans
              "
            >
              <AlertTriangle className="w-5 h-5" />

              Incomplete Paper
            </DialogTitle>
          </DialogHeader>

          <div
            className="
              font-sans
              text-sm
              space-y-3
            "
          >
            <p>
              You have{" "}
              <strong>
                {unanswered}
              </strong>{" "}
              unanswered question
              {unanswered !== 1
                ? "s"
                : ""}.
            </p>

            <p
              className="
                text-gray-500
                text-xs
              "
            >
              For practice you may
              submit anyway —
              unanswered questions
              score 0.
            </p>

            <div
              className="
                flex
                gap-3
                pt-2
              "
            >
              <Button
                variant="outline"
                className="
                  flex-1
                  font-sans
                "
                onClick={() =>
                  setShowIncompleteWarning(
                    false
                  )
                }
              >
                Go Back
              </Button>

              <Button
                className="
                  flex-1
                  bg-amber-600
                  hover:bg-amber-700
                  text-white
                  font-sans
                "
                onClick={doSubmit}
              >
                Submit Anyway
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Notes overlay */}

      {notesOpen && (
        <div
          className="
            absolute
            inset-0
            z-50
            bg-background
          "
        >
          <TopicNotesOverlay
            material={material}
            onClose={() =>
              setNotesOpen(false)
            }
          />
        </div>
      )}
    </div>
  );
}