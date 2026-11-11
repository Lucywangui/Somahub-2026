import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TopicalViewer } from "./TopicalViewer";
import { ExamViewer } from "./ExamViewer";
import { StudyNotesViewer } from "./StudyNotesViewer";
import { MATERIALS } from "@/data/materials";
import { useSomaStore } from "@/lib/storage";
import {
  BookOpen,
  ClipboardList,
  Play,
  RotateCcw,
  X,
} from "lucide-react";

interface Props {
  materialId: string;
  onClose: () => void;
}

type View = "choose" | "notes" | "quiz";

export function ViewerModal({ materialId, onClose }: Props) {
  const material = MATERIALS.find((m) => m.id === materialId);

  const progress = useSomaStore(
    (s) => s.quizProgress[materialId]
  );

  const clearQuizProgress = useSomaStore(
    (s) => s.clearQuizProgress
  );

  const startNewQuestionSet = useSomaStore(
    (s) => s.startNewQuestionSet
  );

  const [view, setView] = useState<View>("choose");
  const [attemptKey, setAttemptKey] = useState(0);

  if (!material) {
    return null;
  }

  const isExam =
    material.type === "exam" ||
    material.title?.toLowerCase().includes("exam");

  // Progress is cleared when a quiz is finished, so any saved progress with
  // at least one answer (or a moved cursor) is an unfinished attempt.
  const resumable =
    !!progress &&
    (progress.currentIndex > 0 ||
      Object.keys(progress.answers ?? {}).length > 0);

  const startFresh = () => {
    clearQuizProgress(materialId);
    setAttemptKey((key) => key + 1);
    setView("quiz");
  };

  const newQuestionSet = () => {
    startNewQuestionSet(materialId);
    setAttemptKey((key) => key + 1);
    setView("quiz");
  };

  const continueQuiz = () => {
    setAttemptKey((key) => key + 1);
    setView("quiz");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="
          fixed
          left-1/2
          top-1/2
          -translate-x-1/2
          -translate-y-1/2
          w-[95vw]
          max-w-[95vw]
          h-[95vh]
          max-h-[95vh]
          p-0
          m-0
          border-0
          rounded-2xl
          overflow-hidden
          flex
          flex-col
          bg-white
          text-black
          opacity-100
          z-[100]
          shadow-2xl
        "
      >
        <div
          className="
            relative
            flex-1
            w-full
            h-full
            min-h-0
            overflow-hidden
            bg-white
            text-black
            opacity-100
          "
        >
          {/* CHOOSE SCREEN */}
          {view === "choose" && (
            <div
              className="
                w-full
                h-full
                min-h-0
                overflow-y-auto
                bg-white
                text-black
              "
            >
              <div className="w-full max-w-3xl mx-auto p-6 sm:p-8">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-2xl font-bold text-black">
                      {material.title}
                    </h2>

                    {material.subject && (
                      <p className="text-gray-600 mt-1">
                        {material.subject}
                      </p>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    aria-label="Close"
                    className="text-black hover:bg-gray-100"
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </div>

                <div className="grid gap-4">
                  {/* STUDY NOTES */}
                  <button
                    type="button"
                    onClick={() => setView("notes")}
                    className="
                      w-full
                      rounded-2xl
                      border
                      border-gray-200
                      bg-white
                      text-black
                      p-5
                      text-left
                      shadow-sm
                      transition
                      hover:shadow-md
                      hover:bg-gray-50
                    "
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-100">
                        <BookOpen className="h-6 w-6 text-blue-600" />
                      </div>

                      <div className="flex-1">
                        <h3 className="font-bold text-lg text-black">
                          Study Notes
                        </h3>

                        <p className="text-sm text-gray-600">
                          Review the notes before taking the quiz.
                        </p>
                      </div>

                      <Play className="h-5 w-5 text-gray-500" />
                    </div>
                  </button>

                  {/* QUIZ */}
                  <button
                    type="button"
                    onClick={() => {
                      if (resumable) {
                        continueQuiz();
                      } else {
                        startFresh();
                      }
                    }}
                    className="
                      w-full
                      rounded-2xl
                      border
                      border-gray-200
                      bg-white
                      text-black
                      p-5
                      text-left
                      shadow-sm
                      transition
                      hover:shadow-md
                      hover:bg-gray-50
                    "
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-purple-100">
                        <ClipboardList className="h-6 w-6 text-purple-600" />
                      </div>

                      <div className="flex-1">
                        <h3 className="font-bold text-lg text-black">
                          {isExam ? "Exam" : "Topical Quiz"}
                        </h3>

                        <p className="text-sm text-gray-600">
                          {resumable
                            ? "Continue your previous attempt."
                            : "Start the quiz and test your knowledge."}
                        </p>
                      </div>

                      <Play className="h-5 w-5 text-gray-500" />
                    </div>
                  </button>

                  {/* START AGAIN */}
                  {resumable && (
                    <Button
                      variant="outline"
                      className="
                        w-full
                        bg-white
                        text-black
                        border-gray-300
                        hover:bg-gray-100
                      "
                      onClick={startFresh}
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Start Again
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* STUDY NOTES */}
          {view === "notes" && (
            <div
              className="
                w-full
                h-full
                min-h-0
                overflow-y-auto
                bg-white
                text-black
              "
            >
              <StudyNotesViewer
                material={material}
                onBack={() => setView("choose")}
                onClose={onClose}
                onTakeQuiz={() =>
                  resumable ? continueQuiz() : startFresh()
                }
              />
            </div>
          )}

          {/* QUIZ */}
          {view === "quiz" && (
            <div
              className="
                relative
                w-full
                h-full
                min-h-0
                overflow-y-auto
                bg-white
                text-black
                opacity-100
              "
            >
              {isExam ? (
                <ExamViewer
                  key={attemptKey}
                  material={material}
                  onClose={onClose}
                  onNewSet={newQuestionSet}
                />
              ) : (
                <TopicalViewer
                  key={attemptKey}
                  material={material}
                  onClose={onClose}
                  onNewSet={newQuestionSet}
                />
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}