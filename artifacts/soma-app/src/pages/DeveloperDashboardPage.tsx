import { useEffect, useState } from "react";

const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ||
  "http://127.0.0.1:5000";

interface DeveloperDashboardPageProps {
  onLogout: () => void;
}

interface RankedStudent {
  rank: number;
  id: number;
  soma_hub_code: string;
  name: string;
  school_name: string;
  grade: string;
  term_key: string;
  study_notes_points: number;
  topical_quiz_points: number;
  exam_points: number;
  consistency_points: number;
  improvement_points: number;
  total_points: number;
}

interface TermPoints {
  term_key: string;
  study_notes_points: number;
  topical_quiz_points: number;
  exam_points: number;
  consistency_points: number;
  improvement_points: number;
  total_points: number;
}

interface QuizResult {
  material_id: string;
  material_title: string;
  subject: string;
  grade_key: string;
  quiz_type: string;
  score: number;
  total: number;
  percentage: number;
  completed_at: string;
}

interface StudentDetails {
  id: number;
  soma_hub_code: string;
  name: string;
  school_name: string;
  grade: string;
  created_at: string;
  updated_at: string;
}

interface StudentResponse {
  success: boolean;
  message?: string;
  student: StudentDetails;
  term_points?: TermPoints[];
  quiz_results?: QuizResult[];
}

export default function DeveloperDashboardPage({
  onLogout,
}: DeveloperDashboardPageProps) {
  const [students, setStudents] = useState<RankedStudent[]>([]);
  const [termKey, setTermKey] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const [selectedStudent, setSelectedStudent] =
    useState<StudentResponse | null>(null);

  const [loadingStudents, setLoadingStudents] = useState(true);
  const [loadingStudent, setLoadingStudent] = useState(false);

  const [error, setError] = useState("");
  const [studentError, setStudentError] = useState("");

  useEffect(() => {
    loadTopStudents();
  }, []);

  async function loadTopStudents() {
    setLoadingStudents(true);
    setError("");

    try {
      const response = await fetch(
        `${API_BASE}/api/admin/top-students`,
        {
          method: "GET",
          credentials: "include",
        }
      );

      const data = await response.json();

      if (response.status === 401) {
        onLogout();
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.message || "Unable to load student rankings."
        );
      }

      setStudents(data.students || []);
      setTermKey(data.term_key || "");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load student rankings."
      );
    } finally {
      setLoadingStudents(false);
    }
  }

  async function searchStudent(
    event?: React.FormEvent,
    codeOverride?: string
  ) {
    event?.preventDefault();

    const code = (
      codeOverride ?? searchCode
    )
      .trim()
      .toUpperCase();

    if (!code) {
      setStudentError("Enter a SOMA HUB Code.");
      return;
    }

    setLoadingStudent(true);
    setStudentError("");
    setSelectedStudent(null);

    try {
      const response = await fetch(
        `${API_BASE}/api/admin/students/${encodeURIComponent(code)}`,
        {
          method: "GET",
          credentials: "include",
        }
      );

      const data = await response.json();

      if (response.status === 401) {
        onLogout();
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.message || "Student not found."
        );
      }

      const normalizedStudent: StudentResponse = {
        ...data,
        term_points: Array.isArray(data.term_points)
          ? data.term_points
          : [],
        quiz_results: Array.isArray(data.quiz_results)
          ? data.quiz_results
          : [],
      };

      setSelectedStudent(normalizedStudent);
    } catch (err) {
      setStudentError(
        err instanceof Error
          ? err.message
          : "Unable to find that student."
      );
    } finally {
      setLoadingStudent(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch(
        `${API_BASE}/api/admin/logout`,
        {
          method: "POST",
          credentials: "include",
        }
      );
    } finally {
      onLogout();
    }
  }

  function formatDate(value: string) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString();
  }

  function getTermLabel(key: string) {
    if (!key) return "Current Term";

    const match = key.match(/^(\d{4})-T([123])$/);

    if (!match) return key;

    const [, year, term] = match;

    return `Term ${term} • ${year}`;
  }

  const termPoints = selectedStudent?.term_points ?? [];
  const quizResults = selectedStudent?.quiz_results ?? [];

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-slate-950 text-white">
        <div className="max-w-7xl mx-auto px-5 py-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-blue-400">
              SOMA HUB
            </p>

            <h1 className="text-2xl font-bold">
              Developer Dashboard
            </h1>

            <p className="text-sm text-slate-400 mt-1">
              Student performance and account management
            </p>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold hover:bg-slate-800"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-5 py-7 space-y-7">
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
          <div className="mb-4">
            <h2 className="text-xl font-bold text-slate-900">
              Find Student
            </h2>

            <p className="text-sm text-slate-500 mt-1">
              Search using the student's SOMA HUB Code.
            </p>
          </div>

          <form
            onSubmit={searchStudent}
            className="flex flex-col sm:flex-row gap-3"
          >
            <input
              type="text"
              value={searchCode}
              onChange={(event) =>
                setSearchCode(
                  event.target.value.toUpperCase()
                )
              }
              placeholder="e.g. SH-3MKA5V"
              className="flex-1 rounded-xl border border-slate-300 px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />

            <button
              type="submit"
              disabled={loadingStudent}
              className="rounded-xl bg-blue-600 px-6 py-3 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {loadingStudent
                ? "Searching..."
                : "Search"}
            </button>
          </form>

          {studentError && (
            <div className="mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {studentError}
            </div>
          )}
        </section>

        {selectedStudent && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
              <div>
                <p className="text-sm font-semibold text-blue-600">
                  STUDENT PROFILE
                </p>

                <h2 className="text-2xl font-bold text-slate-900 mt-1">
                  {selectedStudent.student.name}
                </h2>

                <p className="font-mono text-sm text-slate-500 mt-1">
                  {selectedStudent.student.soma_hub_code}
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedStudent(null)
                }
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase">
                  School
                </p>

                <p className="font-semibold text-slate-900 mt-1">
                  {selectedStudent.student.school_name ||
                    "Not provided"}
                </p>
              </div>

              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase">
                  Grade
                </p>

                <p className="font-semibold text-slate-900 mt-1">
                  {selectedStudent.student.grade ||
                    "Not provided"}
                </p>
              </div>

              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase">
                  Account Created
                </p>

                <p className="font-semibold text-slate-900 mt-1">
                  {formatDate(
                    selectedStudent.student.created_at
                  )}
                </p>
              </div>

              <div className="rounded-xl bg-blue-50 p-4">
                <p className="text-xs font-semibold text-blue-600 uppercase">
                  Current Term Points
                </p>

                <p className="text-2xl font-bold text-blue-700 mt-1">
                  {termPoints[0]?.total_points ?? 0}

                  <span className="text-sm font-medium ml-1">
                    / 100
                  </span>
                </p>
              </div>
            </div>

            <div className="mt-7">
              <h3 className="text-lg font-bold text-slate-900 mb-3">
                Term Performance
              </h3>

              {termPoints.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">
                  No performance data has been synchronized yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {termPoints.map((term) => (
                    <div
                      key={term.term_key}
                      className="rounded-xl border border-slate-200 p-4"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <p className="font-bold text-slate-900">
                          {getTermLabel(
                            term.term_key
                          )}
                        </p>

                        <p className="font-bold text-blue-600">
                          {term.total_points} / 100
                        </p>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                        <PointBox
                          label="Study Notes"
                          value={
                            term.study_notes_points
                          }
                          max={20}
                        />

                        <PointBox
                          label="Topical Quizzes"
                          value={
                            term.topical_quiz_points
                          }
                          max={25}
                        />

                        <PointBox
                          label="Exams"
                          value={term.exam_points}
                          max={25}
                        />

                        <PointBox
                          label="Consistency"
                          value={
                            term.consistency_points
                          }
                          max={15}
                        />

                        <PointBox
                          label="Improvement"
                          value={
                            term.improvement_points
                          }
                          max={15}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-7">
              <h3 className="text-lg font-bold text-slate-900 mb-3">
                Quiz Results
              </h3>

              {quizResults.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">
                  No quiz results have been synchronized yet.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr className="text-left">
                        <th className="px-4 py-3 font-semibold">
                          Material
                        </th>

                        <th className="px-4 py-3 font-semibold">
                          Subject
                        </th>

                        <th className="px-4 py-3 font-semibold">
                          Type
                        </th>

                        <th className="px-4 py-3 font-semibold">
                          Score
                        </th>

                        <th className="px-4 py-3 font-semibold">
                          Percentage
                        </th>

                        <th className="px-4 py-3 font-semibold">
                          Completed
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {quizResults.map(
                        (result, index) => (
                          <tr
                            key={`${result.material_id}-${result.completed_at}-${index}`}
                            className="border-t border-slate-200"
                          >
                            <td className="px-4 py-3 font-medium text-slate-900">
                              {result.material_title ||
                                "Untitled"}
                            </td>

                            <td className="px-4 py-3 text-slate-600">
                              {result.subject || "—"}
                            </td>

                            <td className="px-4 py-3 text-slate-600">
                              {result.quiz_type || "—"}
                            </td>

                            <td className="px-4 py-3 text-slate-700">
                              {result.score} /{" "}
                              {result.total}
                            </td>

                            <td className="px-4 py-3 font-semibold text-slate-900">
                              {result.percentage}%
                            </td>

                            <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                              {formatDate(
                                result.completed_at
                              )}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-5 border-b border-slate-200">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-blue-600">
                  PERFORMANCE RANKING
                </p>

                <h2 className="text-2xl font-bold text-slate-900 mt-1">
                  Top 100 Students
                </h2>
              </div>

              <p className="text-sm text-slate-500">
                {termKey
                  ? getTermLabel(termKey)
                  : "Current term"}
              </p>
            </div>

            <p className="text-sm text-slate-500 mt-2">
              Ranking is based on learning and performance
              points for the current school term.
            </p>
          </div>

          {error && (
            <div className="m-5 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {loadingStudents ? (
            <div className="p-8 text-center text-slate-500">
              Loading student rankings...
            </div>
          ) : students.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No students have been registered yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="text-left">
                    <th className="px-4 py-3 font-semibold">
                      Rank
                    </th>

                    <th className="px-4 py-3 font-semibold">
                      Student
                    </th>

                    <th className="px-4 py-3 font-semibold">
                      SOMA HUB Code
                    </th>

                    <th className="px-4 py-3 font-semibold">
                      School
                    </th>

                    <th className="px-4 py-3 font-semibold">
                      Grade
                    </th>

                    <th className="px-4 py-3 font-semibold text-right">
                      Points
                    </th>

                    <th className="px-4 py-3 font-semibold">
                      Action
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {students.map((student) => (
                    <tr
                      key={student.id}
                      className="border-t border-slate-200 hover:bg-slate-50"
                    >
                      <td className="px-4 py-3 font-bold text-slate-900">
                        #{student.rank}
                      </td>

                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">
                          {student.name ||
                            "Unnamed student"}
                        </p>
                      </td>

                      <td className="px-4 py-3 font-mono text-slate-600 whitespace-nowrap">
                        {student.soma_hub_code}
                      </td>

                      <td className="px-4 py-3 text-slate-600">
                        {student.school_name ||
                          "Not provided"}
                      </td>

                      <td className="px-4 py-3 text-slate-600">
                        {student.grade || "—"}
                      </td>

                      <td className="px-4 py-3 text-right">
                        <span className="font-bold text-blue-600">
                          {student.total_points}
                        </span>

                        <span className="text-slate-400">
                          {" "}
                          / 100
                        </span>
                      </td>

                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            setSearchCode(
                              student.soma_hub_code
                            );

                            setSelectedStudent(null);

                            searchStudent(
                              undefined,
                              student.soma_hub_code
                            );
                          }}
                          className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function PointBox({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-500">
        {label}
      </p>

      <p className="font-bold text-slate-900 mt-1">
        {value}

        <span className="text-xs font-medium text-slate-400">
          {" "}
          / {max}
        </span>
      </p>
    </div>
  );
}