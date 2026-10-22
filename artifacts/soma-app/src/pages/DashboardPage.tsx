import { useState, useMemo, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { motion } from "framer-motion";
import {
  useSomaStore,
  getCurrentSchoolTerm,
  getTermPointsTotal,
  subscriptionCovers,
} from "@/lib/storage";
import { MATERIALS, SUBJECTS_BY_GRADE } from "@/data/materials";
import {
  adjacentGrades,
  gradeDisplayName,
  gradeShortName,
  resolveGrade,
  INTENT_LABELS,
} from "@/data/grade";
import { targetExamFor, projectExam } from "@/data/assessment";
import {
  orderedSubjects,
  recommendedSubjects,
  pathwayById,
} from "@/data/curriculum";
import {
  levelForXp,
  getTopicMastery,
  masteryBand,
  quizzesOn,
  todayString,
} from "@/lib/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MaterialCard } from "@/components/MaterialCard";
import { SubjectFilter } from "@/components/SubjectFilter";
import { AddFundsModal } from "@/components/AddFundsModal";
import { UnlockDialog, type UnlockPrompt } from "@/components/UnlockDialog";
import { unlockMaterial } from "@/lib/account";
import { formatExpiry, renewBanner } from "@/lib/subscription";
import { useToast } from "@/hooks/use-toast";
import {
  requestAndEnableNotifications,
  showTestNotification,
  checkAndShowDailyReminder,
  isNotificationsEnabled,
  setNotificationsEnabled,
  openNotificationSettings,
} from "@/hooks/useNotifications";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import {
  Search,
  Library,
  User,
  Home,
  Bell,
  BellOff,
  Plus,
  Flame,
  ChevronDown,
  Play,
  Target,
  Sparkles,
} from "lucide-react";

interface Props {
  onOpenViewer: (id: string) => void;
  onChangeGrade: () => void;
  /** Lets the app also close the viewer and reset its own page state. */
  onLogout?: () => void;
}

const CHART_COLORS = [
  "#1a3a5c",
  "#e67e22",
  "#27ae60",
  "#8e44ad",
  "#e74c3c",
  "#2980b9",
  "#f39c12",
  "#16a085",
  "#d35400",
  "#2c3e50",
];

function firstMaterialFor(gradeKey: string, subject: string, topic?: string) {
  const pool = MATERIALS.filter(
    (m) =>
      m.gradeKey === gradeKey &&
      m.subject === subject &&
      m.type === "topical",
  );

  if (topic) {
    const hit = pool.find((m) => m.topics.includes(topic));
    if (hit) return hit;
  }

  return (
    pool[0] ??
    MATERIALS.find(
      (m) => m.gradeKey === gradeKey && m.subject === subject,
    )
  );
}

export function DashboardPage({ onOpenViewer, onChangeGrade, onLogout }: Props) {
  const {
    name,
    avatar,
    grade,
    schoolName,
    somaHubCode,
    studyIntent,
    pathway,
    activeGrade,
    setActiveGrade,
    wallet,
    ksh,
    subscription,
    xp,
    streak,
    dailyGoal,
    termPoints,
    purchased,
    removePurchased,
    logout,
    quizResults,
    quizProgress,
  } = useSomaStore();

  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<
    "home" | "search" | "library" | "profile"
  >("home");

  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<string>("All");
  const [isAddFundsOpen, setIsAddFundsOpen] = useState(false);
  const [unlockPrompt, setUnlockPrompt] = useState<
    (UnlockPrompt & { openAfter: boolean }) | null
  >(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [gradeMenuOpen, setGradeMenuOpen] = useState(false);
  const [notifsEnabled, setNotifsEnabled] =
    useState(isNotificationsEnabled);
  const [showNotificationWelcome, setShowNotificationWelcome] =
    useState(false);

  // Invite the learner to enable notifications at most once per local day.
  useEffect(() => {
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const alreadyEnabled =
        localStorage.getItem("somaHubNotificationsEnabled") === "true";
      const lastPromptDate =
        localStorage.getItem("somaHubNotificationPromptDate");

      if (!alreadyEnabled && lastPromptDate !== today) {
        setShowNotificationWelcome(true);
        localStorage.setItem("somaHubNotificationPromptDate", today);
      }
    } catch (error) {
      console.error("Could not check notification welcome prompt:", error);
    }
  }, [name]);

  useEffect(() => {
    void checkAndShowDailyReminder(name ?? undefined);
  }, [name]);

  // Synchronise permission after returning from the operating system settings.
  useEffect(() => {
    const syncNotificationPermission = async () => {
      try {
        let granted = false;

        if (Capacitor.isNativePlatform()) {
          const permission =
            await LocalNotifications.checkPermissions();
          granted = permission.display === "granted";
        } else if (typeof Notification !== "undefined") {
          granted = Notification.permission === "granted";
        }

        setNotificationsEnabled(granted);
        setNotifsEnabled(granted);

        if (granted) {
          await checkAndShowDailyReminder(name ?? undefined);
        }
      } catch (error) {
        console.error("Could not sync notification permission:", error);
      }
    };

    const handleReturnToApp = () => {
      if (document.visibilityState === "visible") {
        void syncNotificationPermission();
      }
    };

    document.addEventListener("visibilitychange", handleReturnToApp);
    window.addEventListener("focus", handleReturnToApp);

    return () => {
      document.removeEventListener("visibilitychange", handleReturnToApp);
      window.removeEventListener("focus", handleReturnToApp);
    };
  }, [name]);

  // Fallback keeps derived hooks safe during the brief render after logout,
  // before App navigates away.
  const homeGrade = grade ?? "cbc-4";
  const browsing = activeGrade ?? homeGrade;
  const isExploring = browsing !== homeGrade;

  const { below, above } = useMemo(
    () => adjacentGrades(homeGrade),
    [homeGrade],
  );

  // Pathway sorts subjects (recommended first) — it never hides any.
  const recommended = useMemo(
    () => recommendedSubjects(browsing, pathway),
    [browsing, pathway],
  );

  const subjects = useMemo(
    () =>
      orderedSubjects(
        browsing,
        SUBJECTS_BY_GRADE(browsing),
        pathway,
      ),
    [browsing, pathway],
  );

  const gradeMaterials = useMemo(
    () => MATERIALS.filter((m) => m.gradeKey === browsing),
    [browsing],
  );

  const purchasedMaterials = useMemo(
    () => MATERIALS.filter((m) => purchased.includes(m.id)),
    [purchased],
  );

  const level = levelForXp(xp);

  // Current SOMA HUB school term and its separate 0–100 score.
  const currentSchoolTerm = getCurrentSchoolTerm();

  const currentTermKey =
    `${currentSchoolTerm.year}-T${currentSchoolTerm.term}`;

  const currentTermPoints =
    termPoints[currentTermKey];

  const currentTermTotal = currentTermPoints
    ? getTermPointsTotal(currentTermPoints)
    : 0;

  const targetExam = useMemo(
    () => targetExamFor(homeGrade),
    [homeGrade],
  );

  const projection = useMemo(
    () => projectExam(quizResults, homeGrade),
    [quizResults, homeGrade],
  );

  const mastery = useMemo(
    () => getTopicMastery(quizResults),
    [quizResults],
  );

  const todayCount = quizzesOn(
    quizResults,
    todayString(),
  );

  const inProgress = useMemo(
    () =>
      Object.values(quizProgress)
        .map((p) =>
          MATERIALS.find((m) => m.id === p.materialId),
        )
        .filter(Boolean)
        .slice(0, 3),
    [quizProgress],
  );

  const weakSpots = useMemo(
    () =>
      [...mastery]
        .sort((a, b) => a.mastery - b.mastery)
        .slice(0, 3),
    [mastery],
  );

  const recentSubjects = useMemo(() => {
    const seen: string[] = [];

    for (const r of quizResults) {
      if (!seen.includes(r.subject)) {
        seen.push(r.subject);
      }
    }

    return seen.slice(0, 4);
  }, [quizResults]);

  const filteredMaterials = useMemo(() => {
    const q = search.toLowerCase();

    return gradeMaterials.filter((m) => {
      const matchesSearch =
        m.title.toLowerCase().includes(q) ||
        m.subject.toLowerCase().includes(q);

      const matchesSubject =
        subjectFilter === "All" ||
        m.subject === subjectFilter;

      return matchesSearch && matchesSubject;
    });
  }, [gradeMaterials, search, subjectFilter]);

  const pieData = useMemo(() => {
    const source =
      purchased.length > 0
        ? purchasedMaterials
        : gradeMaterials;

    const counts: Record<string, number> = {};

    source.forEach((m) => {
      counts[m.subject] =
        (counts[m.subject] || 0) + 1;
    });

    return Object.entries(counts).map(
      ([n, value]) => ({
        name: n,
        value,
      }),
    );
  }, [
    gradeMaterials,
    purchasedMaterials,
    purchased.length,
  ]);

  /**
   * Unlocks on the server. A coin shortfall opens the unlock
   * dialog, which asks before any KSh is spent.
   */
  const unlock = async (
    id: string,
    { openAfter, allowKsh }: { openAfter: boolean; allowKsh: boolean },
  ) => {
    setIsUnlocking(true);
    const result = await unlockMaterial(id, allowKsh);
    setIsUnlocking(false);

    if (result.status === "unlocked") {
      setUnlockPrompt(null);

      if (!result.alreadyUnlocked && !result.viaSubscription) {
        toast({
          title: "Opened",
          description:
            result.kshSpent > 0
              ? `Added to your library. KSh ${result.kshSpent} paid from your wallet.`
              : "Added to your library.",
        });
      }

      if (openAfter) onOpenViewer(id);
      return;
    }

    if (result.status === "short") {
      setUnlockPrompt({
        materialId: id,
        title:
          MATERIALS.find((m) => m.id === id)?.title ?? "Unlock material",
        coins: result.coins,
        price: result.price,
        ksh: result.ksh,
        kshNeeded: result.kshNeeded,
        canPayWithKsh: result.canPayWithKsh,
        openAfter,
      });
      return;
    }

    toast({
      variant: "destructive",
      title: "Couldn't unlock",
      description: result.message,
    });
  };

  /** Unlocked with coins, or covered by an active subscription. */
  const canOpen = (id: string) =>
    purchased.includes(id) || subscriptionCovers(subscription, id);

  const banner = renewBanner(subscription);

  const handleBuy = (id: string) =>
    unlock(id, { openAfter: false, allowKsh: false });

  const openOrBuy = (id: string) => {
    if (canOpen(id)) {
      onOpenViewer(id);
      return;
    }

    void unlock(id, { openAfter: true, allowKsh: false });
  };

  const handleToggleNotifications = async () => {
    if (notifsEnabled) {
      setNotificationsEnabled(false);
      setNotifsEnabled(false);

      toast({
        title: "Reminders off",
      });
    } else {
      const granted =
        await requestAndEnableNotifications();

      if (granted) {
        setNotifsEnabled(true);
        showTestNotification(name ?? undefined);

        toast({
          title: "🔔 Daily reminders on",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Permission denied",
          description:
            "Allow notifications in browser settings.",
        });
      }
    }
  };

  const handleEnableWelcomeNotifications = async () => {
    setShowNotificationWelcome(false);

    try {
      await openNotificationSettings();
    } catch (error) {
      console.error("Could not open notification settings:", error);
      toast({
        variant: "destructive",
        title: "Couldn't open notification settings",
        description:
          "Open your phone's Settings, find SOMA HUB, and allow notifications.",
      });
    }
  };

  if (!grade) return null;

  const tabs = [
    {
      id: "home",
      label: "Today",
      icon: Home,
    },
    {
      id: "search",
      label: "Explore",
      icon: Search,
    },
    {
      id: "library",
      label: "Library",
      icon: Library,
    },
    {
      id: "profile",
      label: "Profile",
      icon: User,
    },
  ] as const;

  const gradeChoices = [
    ...below.map((g) => ({
      g,
      tag: "revision",
    })),
    {
      g: homeGrade,
      tag: "my class",
    },
    ...above.map((g) => ({
      g,
      tag: "stretch",
    })),
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top App Bar */}
      <header
        className="sticky top-0 z-20 px-4 py-3 shadow-md"
        style={{
          background:
            "linear-gradient(90deg, #0d2137, #1a3a5c)",
        }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-2xl leading-none select-none">
              {avatar}
            </span>

            <div className="min-w-0">
              <p className="text-white font-extrabold text-base leading-tight">
                SOMA
              </p>

              <div className="relative">
                <button
                  onClick={() =>
                    setGradeMenuOpen((o) => !o)
                  }
                  className="flex items-center gap-1 text-xs font-medium text-white/60 hover:text-white/90"
                >
                  {gradeDisplayName(browsing)}
                  {isExploring && " · exploring"}

                  <ChevronDown className="w-3 h-3" />
                </button>

                {gradeMenuOpen && (
                  <div className="absolute left-0 top-6 z-30 w-52 rounded-xl bg-white shadow-xl border overflow-hidden">
                    {gradeChoices.map(
                      ({ g, tag }) => (
                        <button
                          key={g}
                          onClick={() => {
                            setActiveGrade(
                              g === homeGrade
                                ? null
                                : g,
                            );

                            setGradeMenuOpen(false);
                            setSubjectFilter("All");
                          }}
                          className={`w-full text-left px-3 py-2.5 text-sm flex items-center justify-between hover:bg-muted ${g === browsing
                              ? "font-bold text-primary"
                              : "text-foreground"
                            }`}
                        >
                          {gradeDisplayName(g)}

                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {tag}
                          </span>
                        </button>
                      ),
                    )}

                    <button
                      onClick={() => {
                        setGradeMenuOpen(false);
                        onChangeGrade();
                      }}
                      className="w-full text-left px-3 py-2.5 text-xs text-muted-foreground border-t hover:bg-muted"
                    >
                      Change my class…
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold text-white"
              style={{
                background:
                  "rgba(255,255,255,0.12)",
              }}
            >
              <Flame
                className="w-3.5 h-3.5"
                style={{
                  color:
                    streak.count > 0
                      ? "#ff9d4d"
                      : "rgba(255,255,255,0.4)",
                }}
              />
              {streak.count}
            </span>

            <span
              className="px-2.5 py-1.5 rounded-full text-xs font-bold text-white"
              style={{
                background:
                  "rgba(255,255,255,0.12)",
              }}
            >
              Lv {level.level}
            </span>

            <button
              className="flex items-center gap-1 whitespace-nowrap shrink-0 px-3 py-1.5 rounded-full font-bold text-xs text-white"
              style={{
                background:
                  "rgba(255,255,255,0.12)",
              }}
              onClick={() =>
                setIsAddFundsOpen(true)
              }
            >
              🪙 {wallet}
              {ksh !== null && ksh > 0 && (
                <span className="opacity-80">· KSh {ksh}</span>
              )}
              <Plus className="w-3 h-3 opacity-70" />
            </button>
          </div>
        </div>

        {isExploring && (
          <button
            onClick={() => setActiveGrade(null)}
            className="mt-2 w-full text-xs font-semibold text-white rounded-lg py-1.5"
            style={{
              background:
                "rgba(230,126,34,0.9)",
            }}
          >
            Exploring{" "}
            {gradeDisplayName(browsing)} — tap to go
            back to my class
          </button>
        )}
      </header>

      <main className="flex-1 pb-24">
        {/* ── TODAY ── */}
        {activeTab === "home" && (
          <div className="max-w-2xl mx-auto px-4 pt-5 space-y-4">
            {banner && subscription && (
              <div
                className="rounded-2xl border px-4 py-3 flex items-center gap-3 bg-card"
                data-testid="renew-banner"
              >
                <span className="text-2xl">⏰</span>
                <p className="text-sm flex-1">
                  {banner.kind === "ending"
                    ? `Your ${gradeShortName(subscription.gradeKey)} subscription ends on ${formatExpiry(subscription.expiresAt)}.`
                    : `Your ${gradeShortName(subscription.gradeKey)} subscription has ended.`}
                </p>
                <Button
                  size="sm"
                  className="rounded-xl"
                  onClick={() => setIsAddFundsOpen(true)}
                >
                  Renew
                </Button>
              </div>
            )}

            {/* Greeting + level */}
            <motion.div
              className="rounded-3xl p-5 text-white shadow-xl"
              style={{
                background:
                  "linear-gradient(135deg, #1a3a5c, #1e5799)",
              }}
              initial={{
                opacity: 0,
                y: 16,
              }}
              animate={{
                opacity: 1,
                y: 0,
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="rounded-2xl p-2.5 text-3xl leading-none select-none"
                  style={{
                    background:
                      "rgba(255,255,255,0.12)",
                  }}
                >
                  {avatar}
                </div>

                <div className="min-w-0">
                  <p className="text-xs font-medium opacity-70">
                    {studyIntent === "exam" &&
                      targetExam
                      ? `Working toward ${targetExam.code}`
                      : studyIntent
                        ? INTENT_LABELS[
                          studyIntent
                        ].title
                        : "Welcome back"}
                  </p>

                  <h2 className="text-2xl font-extrabold tracking-tight truncate">
                    Hi {name}!
                  </h2>
                </div>
              </div>

              <div className="mt-4">
                <div className="flex justify-between text-xs opacity-80 mb-1">
                  <span>
                    Level {level.level}
                  </span>

                  <span>
                    {level.into} / {level.span} XP
                  </span>
                </div>

                <div className="h-2.5 rounded-full bg-white/15 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{
                      background: "#e67e22",
                    }}
                    initial={{
                      width: 0,
                    }}
                    animate={{
                      width: `${(level.into /
                        level.span) *
                        100
                        }%`,
                    }}
                    transition={{
                      duration: 0.7,
                    }}
                  />
                </div>
              </div>
            </motion.div>

            {/* Daily goal */}
            <div className="rounded-2xl bg-card border shadow-sm p-4 flex items-center gap-4">
              <div className="relative w-14 h-14 shrink-0">
                <svg
                  viewBox="0 0 36 36"
                  className="w-14 h-14 -rotate-90"
                >
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="#eee"
                    strokeWidth="4"
                  />

                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="#27ae60"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={`${Math.min(
                      1,
                      todayCount /
                      dailyGoal,
                    ) * 100
                      } 100`}
                  />
                </svg>

                <span className="absolute inset-0 flex items-center justify-center text-sm font-extrabold">
                  {todayCount}/{dailyGoal}
                </span>
              </div>

              <div className="min-w-0">
                <p className="font-bold text-foreground">
                  {todayCount >= dailyGoal
                    ? "Daily goal done! 🎉"
                    : "Today's goal"}
                </p>

                <p className="text-xs text-muted-foreground">
                  {todayCount >= dailyGoal
                    ? "Every extra quiz still earns XP and coins."
                    : `Finish ${dailyGoal -
                    todayCount
                    } more quiz${dailyGoal -
                      todayCount !==
                      1
                      ? "zes"
                      : ""
                    } to keep your streak.`}
                </p>
              </div>
            </div>

            {/* Projected national assessment */}
            {targetExam && (
              <div
                className="rounded-2xl border shadow-sm p-4 text-white"
                style={{
                  background:
                    "linear-gradient(135deg, #0d2137, #1a3a5c)",
                }}
              >
                <div className="flex items-center justify-between">
                  <p className="font-bold">
                    Your {targetExam.code} so far
                  </p>

                  <span className="text-[10px] uppercase tracking-wide opacity-60">
                    sat in{" "}
                    {gradeShortName(
                      `cbc-${targetExam.atGrade}`,
                    )}
                  </span>
                </div>

                {projection ? (
                  <>
                    <p className="text-2xl font-extrabold mt-1">
                      {projection.level
                        ? projection.level.label
                        : `Grade ${projection.kcse?.grade} · ${projection.kcse?.points} points`}
                    </p>

                    <p className="text-xs opacity-80 mt-1">
                      Based on your practice (
                      {projection.sbaPercent}%) and
                      your best practice exam (
                      {projection.summativePercent}%).
                      Keep practising to move it up.
                    </p>

                    <div className="mt-2 h-2 rounded-full bg-white/15 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${projection.blendedPercent}%`,
                          background:
                            "#e67e22",
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm opacity-75 mt-1">
                    Finish a few quizzes and one
                    practice exam and we'll show
                    how you're tracking.
                  </p>
                )}
              </div>
            )}

            {/* Continue */}
            {inProgress.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-extrabold text-foreground flex items-center gap-1.5">
                  <Play className="w-4 h-4 text-primary" />
                  Continue
                </h3>

                {inProgress.map(
                  (m) =>
                    m && (
                      <button
                        key={m.id}
                        onClick={() =>
                          onOpenViewer(m.id)
                        }
                        className="w-full flex items-center justify-between rounded-2xl border-2 border-orange-200 bg-orange-50 p-3.5 text-left hover:border-orange-400 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="font-bold text-sm truncate">
                            {m.title}
                          </p>

                          <p className="text-xs text-orange-700">
                            {m.subject} · resume where
                            you left off
                          </p>
                        </div>

                        <span className="text-orange-600 font-bold shrink-0 ml-2">
                          ▶
                        </span>
                      </button>
                    ),
                )}
              </section>
            )}

            {/* Weak spots */}
            {weakSpots.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-extrabold text-foreground flex items-center gap-1.5">
                  <Target className="w-4 h-4 text-primary" />
                  Practise your weak spots
                </h3>

                {weakSpots.map((w) => {
                  const b = masteryBand(
                    w.mastery,
                  );

                  const mat = firstMaterialFor(
                    browsing,
                    w.subject,
                    w.topic,
                  );

                  return (
                    <button
                      key={w.key}
                      onClick={() =>
                        mat &&
                        openOrBuy(mat.id)
                      }
                      disabled={!mat}
                      className="w-full flex items-center justify-between rounded-2xl border bg-card p-3.5 text-left hover:border-primary/50 transition-colors disabled:opacity-50"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-sm truncate">
                          {w.topic}
                        </p>

                        <p className="text-xs text-muted-foreground">
                          {w.subject}
                        </p>
                      </div>

                      <span
                        className="text-xs font-bold shrink-0 ml-2 px-2 py-1 rounded-full"
                        style={{
                          background: `${b.color}22`,
                          color: b.color,
                        }}
                      >
                        {w.mastery}%
                      </span>
                    </button>
                  );
                })}
              </section>
            )}

            {/* Jump back in / first-time */}
            <section className="space-y-2">
              <h3 className="font-extrabold text-foreground flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-primary" />

                {recentSubjects.length
                  ? "Jump back in"
                  : "Start here"}
              </h3>

              <div className="grid grid-cols-2 gap-2">
                {(
                  recentSubjects.length
                    ? recentSubjects
                    : subjects.slice(0, 4)
                ).map((s) => {
                  const mat =
                    firstMaterialFor(
                      browsing,
                      s,
                    );

                  return (
                    <button
                      key={s}
                      onClick={() =>
                        mat &&
                        openOrBuy(mat.id)
                      }
                      disabled={!mat}
                      className="rounded-2xl border bg-card p-3 text-left hover:border-primary/50 transition-colors disabled:opacity-40"
                    >
                      <p className="font-bold text-sm truncate">
                        {s}
                      </p>

                      <p className="text-xs text-muted-foreground">
                        Practise now →
                      </p>
                    </button>
                  );
                })}
              </div>

              <Button
                variant="ghost"
                className="w-full text-sm"
                onClick={() =>
                  setActiveTab("search")
                }
              >
                Browse all{" "}
                {gradeMaterials.length} materials →
              </Button>
            </section>

            {/* Progress chart */}
            {quizResults.length > 0 &&
              (() => {
                const recent =
                  quizResults
                    .slice(0, 10)
                    .reverse();

                const chartData =
                  recent.map((r, i) => ({
                    name: `#${quizResults.length -
                      (recent.length -
                        1 -
                        i)
                      }`,
                    score: r.percentage,
                    title: r.materialTitle,
                  }));

                const avgScore =
                  Math.round(
                    quizResults
                      .slice(0, 10)
                      .reduce(
                        (s, r) =>
                          s +
                          r.percentage,
                        0,
                      ) /
                    Math.min(
                      quizResults.length,
                      10,
                    ),
                  );

                return (
                  <motion.div
                    className="rounded-3xl bg-card p-5 shadow-sm border space-y-3"
                    initial={{
                      opacity: 0,
                      y: 16,
                    }}
                    animate={{
                      opacity: 1,
                      y: 0,
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-lg">
                        📈 Recent scores
                      </h3>

                      <span className="text-xs text-muted-foreground">
                        avg {avgScore}%
                      </span>
                    </div>

                    <ResponsiveContainer
                      width="100%"
                      height={150}
                    >
                      <BarChart
                        data={chartData}
                        margin={{
                          top: 4,
                          right: 4,
                          left: -20,
                          bottom: 4,
                        }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="#f0f0f0"
                        />

                        <XAxis
                          dataKey="name"
                          tick={{
                            fontSize: 10,
                          }}
                          tickLine={false}
                          axisLine={false}
                        />

                        <YAxis
                          domain={[0, 100]}
                          tick={{
                            fontSize: 10,
                          }}
                          tickLine={false}
                          axisLine={false}
                        />

                        <Tooltip
                          contentStyle={{
                            borderRadius: 10,
                            border: "none",
                            boxShadow:
                              "0 4px 20px rgba(0,0,0,0.1)",
                            fontSize: 12,
                          }}
                          formatter={(
                            v: number,
                            _n,
                            p: {
                              payload?: {
                                title?: string;
                              };
                            },
                          ) => [
                              `${v}%`,
                              p.payload?.title ??
                              "",
                            ]}
                        />

                        <ReferenceLine
                          y={50}
                          stroke="#e74c3c"
                          strokeDasharray="4 4"
                        />

                        <Bar
                          dataKey="score"
                          radius={[
                            6,
                            6,
                            0,
                            0,
                          ]}
                        >
                          {chartData.map(
                            (e, i) => (
                              <Cell
                                key={i}
                                fill={
                                  e.score >= 80
                                    ? "#27ae60"
                                    : e.score >= 50
                                      ? "#e67e22"
                                      : "#e74c3c"
                                }
                              />
                            ),
                          )}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </motion.div>
                );
              })()}
          </div>
        )}

        {/* ── EXPLORE ── */}
        {activeTab === "search" && (
          <div className="max-w-7xl mx-auto px-4 pt-5 space-y-4">
            <div className="flex flex-wrap gap-2">
              {gradeChoices.map(
                ({ g, tag }) => (
                  <button
                    key={g}
                    onClick={() => {
                      setActiveGrade(
                        g === homeGrade
                          ? null
                          : g,
                      );
                      setSubjectFilter("All");
                    }}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-colors ${g === browsing
                        ? "border-primary bg-primary text-white"
                        : "border-muted text-muted-foreground hover:border-primary/40"
                      }`}
                  >
                    {gradeDisplayName(g)}{" "}
                    <span className="opacity-70">
                      · {tag}
                    </span>
                  </button>
                ),
              )}
            </div>

            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground w-5 h-5" />

              <Input
                type="search"
                placeholder="Search materials, subjects…"
                className="pl-11 py-6 text-base rounded-2xl border-2 bg-white"
                value={search}
                onChange={(e) =>
                  setSearch(e.target.value)
                }
              />
            </div>

            <SubjectFilter
              subjects={subjects}
              active={subjectFilter}
              onChange={setSubjectFilter}
              recommended={recommended}
            />

            {filteredMaterials.length === 0 ? (
              <div className="text-center py-24 text-muted-foreground">
                <div className="text-5xl mb-3">
                  🔍
                </div>

                <p className="text-xl font-semibold">
                  No materials found.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredMaterials.map(
                  (m) => (
                    <MaterialCard
                      key={m.id}
                      material={m}
                      isPurchased={canOpen(m.id)}
                      onBuy={() =>
                        handleBuy(m.id)
                      }
                      onOpen={() =>
                        onOpenViewer(m.id)
                      }
                    />
                  ),
                )}
              </div>
            )}
          </div>
        )}

                {/* ── LIBRARY ── */}
        {activeTab === "library" && (
          <div className="max-w-7xl mx-auto px-4 pt-5">
            <h2 className="text-xl font-extrabold mb-4">
              My Library{" "}
              <span className="ml-2 text-sm font-semibold text-white bg-primary px-2 py-0.5 rounded-full">
                {purchasedMaterials.length}
              </span>
            </h2>

            {purchasedMaterials.length === 0 ? (
              <div className="text-center py-24 rounded-3xl border-2 border-dashed border-muted bg-muted/20">
                <div className="text-6xl mb-4">
                  📖
                </div>

                <h3 className="text-xl font-bold mb-2">
                  Nothing here yet
                </h3>

                <p className="text-muted-foreground mb-6">
                  Open a material from Explore or
                  Today to start.
                </p>

                <Button
                  onClick={() =>
                    setActiveTab("search")
                  }
                  className="rounded-full px-8"
                >
                  Browse materials
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {purchasedMaterials.map((m) => (
                  <MaterialCard
                    key={m.id}
                    material={m}
                    isPurchased
                    onBuy={() => {}}
                    onOpen={() =>
                      onOpenViewer(m.id)
                    }
                    onDelete={() => {
                      removePurchased(m.id);

                      toast({
                        title: "Removed",
                        description: `${m.title} removed.`,
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── PROFILE ── */}
        {activeTab === "profile" && (
          <div className="max-w-md mx-auto px-4 pt-5 space-y-4">
            <motion.div
              className="rounded-3xl p-7 text-center shadow-xl text-white"
              style={{
                background:
                  "linear-gradient(135deg, #1a3a5c, #1e5799)",
              }}
              initial={{
                opacity: 0,
                y: 16,
              }}
              animate={{
                opacity: 1,
                y: 0,
              }}
            >
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-4xl mx-auto mb-3 select-none"
                style={{
                  background:
                    "rgba(255,255,255,0.12)",
                }}
              >
                {avatar}
              </div>

              <h2 className="text-2xl font-extrabold">
                {name}
              </h2>

              <p className="text-sm mt-1 opacity-70">
                {gradeDisplayName(homeGrade)} · Level {level.level}
              </p>

              {/* School name */}
              <p className="text-sm mt-1 opacity-80">
                {schoolName || "School not added"}
              </p>

              {/* SOMA HUB student code */}
              <p className="text-xs mt-2 opacity-60">
                SOMA HUB Code: {somaHubCode}
              </p>

              <div className="flex justify-center gap-2 mt-3 text-xs font-bold">
                <span
                  className="px-2.5 py-1 rounded-full"
                  style={{
                    background:
                      "rgba(255,255,255,0.14)",
                  }}
                >
                  🔥 {streak.count} day
                  {streak.count !== 1 ? "s" : ""}
                </span>

                <span
                  className="px-2.5 py-1 rounded-full"
                  style={{
                    background:
                      "rgba(255,255,255,0.14)",
                  }}
                >
                  Best {streak.best}
                </span>

                <span
                  className="px-2.5 py-1 rounded-full"
                  style={{
                    background:
                      "rgba(255,255,255,0.14)",
                  }}
                >
                  🪙 {wallet}
                </span>
              </div>

              {/* Current school term score */}
              <div
                className="mt-4 rounded-2xl px-4 py-3 text-left"
                style={{
                  background:
                    "rgba(255,255,255,0.10)",
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs opacity-70">
                    Term {currentSchoolTerm.term} · {currentSchoolTerm.year}
                  </span>

                  <span className="text-lg font-extrabold">
                    {currentTermTotal}/100
                  </span>
                </div>

                <div className="mt-2 h-2 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${currentTermTotal}%`,
                      background: "#e67e22",
                    }}
                  />
                </div>

                <p className="text-[11px] mt-1.5 opacity-60">
                  Learning & engagement points
                </p>
              </div>
            </motion.div>

            {studyIntent && (
              <button
                onClick={onChangeGrade}
                className="w-full rounded-2xl bg-card border shadow-sm p-4 flex items-center gap-3 text-left hover:border-primary/40"
              >
                <span className="text-2xl">
                  {INTENT_LABELS[studyIntent].emoji}
                </span>

                <span className="min-w-0">
                  <span className="block font-bold text-sm">
                    {INTENT_LABELS[studyIntent].title}
                  </span>

                  <span className="block text-xs text-muted-foreground">
                    {resolveGrade(homeGrade).band === "senior" &&
                    pathwayById(pathway)
                      ? `${pathwayById(pathway)!.emoji} ${pathwayById(pathway)!.title} pathway · tap to change`
                      : "Tap to change class or goal"}
                  </span>
                </span>
              </button>
            )}

            {/* Mastery */}
            {mastery.length > 0 && (
              <div className="rounded-2xl bg-card border shadow-sm p-4 space-y-3">
                <h3 className="font-bold">
                  Topic mastery
                </h3>

                {[...mastery]
                  .sort(
                    (a, b) =>
                      b.mastery - a.mastery,
                  )
                  .slice(0, 8)
                  .map((m) => {
                    const b = masteryBand(m.mastery);

                    return (
                      <div key={m.key}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-medium truncate pr-2">
                            {m.topic}{" "}
                            <span className="text-muted-foreground">
                              · {m.subject}
                            </span>
                          </span>

                          <span
                            className="font-bold shrink-0"
                            style={{
                              color: b.color,
                            }}
                          >
                            {m.mastery}%
                          </span>
                        </div>

                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${m.mastery}%`,
                              background: b.color,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Curriculum pie */}
            <div className="rounded-2xl bg-card border shadow-sm p-4">
              <h3 className="font-bold mb-2">
                {purchased.length > 0
                  ? "Activity by subject"
                  : "Curriculum overview"}
              </h3>

              <ResponsiveContainer
                width="100%"
                height={200}
              >
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {pieData.map((_, i) => (
                      <Cell
                        key={i}
                        fill={
                          CHART_COLORS[
                            i % CHART_COLORS.length
                          ]
                        }
                      />
                    ))}
                  </Pie>

                  <Tooltip
                    formatter={(v: number) => [
                      `${v} materials`,
                      "",
                    ]}
                    contentStyle={{
                      borderRadius: 12,
                      border: "none",
                    }}
                  />

                  <Legend
                    formatter={(v) => (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#555",
                        }}
                      >
                        {v.length > 12
                          ? v.slice(0, 12) + "…"
                          : v}
                      </span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Notifications */}
            <div
              className="rounded-2xl p-4 border-2 shadow-sm"
              style={{
                borderColor: notifsEnabled
                  ? "#e67e22"
                  : "#e2e8f0",
                background: notifsEnabled
                  ? "#fff9f4"
                  : "#f8fafc",
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {notifsEnabled ? (
                    <Bell
                      className="w-5 h-5"
                      style={{
                        color: "#e67e22",
                      }}
                    />
                  ) : (
                    <BellOff className="w-5 h-5 text-muted-foreground" />
                  )}

                  <p className="font-bold">
                    Daily reminder
                  </p>
                </div>

                <button
                  onClick={handleToggleNotifications}
                  className="relative w-12 h-6 rounded-full transition-colors"
                  style={{
                    background: notifsEnabled
                      ? "#e67e22"
                      : "#cbd5e1",
                  }}
                  aria-label={
                    notifsEnabled
                      ? "Turn off notifications"
                      : "Turn on notifications"
                  }
                  aria-pressed={notifsEnabled}
                >
                  <span
                    className="absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform"
                    style={{
                      left: notifsEnabled
                        ? "calc(100% - 20px)"
                        : "4px",
                    }}
                  />
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                {notifsEnabled
                  ? "You'll get a nudge each day to keep your streak alive."
                  : "Get a daily nudge to practise and keep your streak."}
              </p>
            </div>

            <Button
              variant="outline"
              className="w-full rounded-2xl py-6 font-semibold border-2"
              onClick={onChangeGrade}
            >
              Change class / goal
            </Button>

            <button
              className="w-full rounded-2xl py-4 font-semibold text-sm border-2 border-red-200 text-red-500 hover:bg-red-50"
              onClick={() => {
                if (
                  window.confirm(
                    "Log out? Your progress on this device will be cleared.",
                  )
                ) {
                  (onLogout ?? logout)();
                }
              }}
            >
              🚪 Log out
            </button>
          </div>
        )}
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-20 flex border-t shadow-2xl bg-white">
        {tabs.map(
          ({
            id,
            label,
            icon: Icon,
          }) => {
            const isActive = activeTab === id;

            return (
              <button
                key={id}
                className="flex-1 flex flex-col items-center justify-center py-3 gap-0.5 relative"
                style={{
                  color: isActive
                    ? "#1a3a5c"
                    : "#999",
                }}
                onClick={() => setActiveTab(id)}
                data-testid={`tab-${id}`}
              >
                <Icon
                  className="w-5 h-5"
                  style={{
                    transform: isActive
                      ? "scale(1.15)"
                      : "scale(1)",
                  }}
                  strokeWidth={isActive ? 2.5 : 1.8}
                />

                <span className="text-xs font-semibold">
                  {label}
                </span>

                {isActive && (
                  <motion.div
                    layoutId="tab-indicator"
                    className="absolute bottom-0 h-0.5 w-10 rounded-full"
                    style={{
                      background: "#e67e22",
                    }}
                  />
                )}
              </button>
            );
          },
        )}
      </nav>

      {/* Notification welcome popup */}
      {showNotificationWelcome && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-5 py-6"
          role="presentation"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-welcome-title"
            aria-describedby="notification-welcome-description"
            className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl"
            initial={{
              opacity: 0,
              scale: 0.92,
              y: 16,
            }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
            }}
            transition={{
              duration: 0.22,
            }}
          >
            <div
              className="px-6 pt-7 pb-6 text-center"
              style={{
                background:
                  "linear-gradient(145deg, #fff7ed, #fff1f2)",
              }}
            >
              <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm">
                <span className="text-5xl" aria-hidden="true">
                  🐦
                </span>
              </div>

              <h2
                id="notification-welcome-title"
                className="text-2xl font-extrabold tracking-tight"
                style={{
                  color: "#1a3a5c",
                }}
              >
                Hi, learner!
              </h2>

              <p
                id="notification-welcome-description"
                className="mt-3 text-sm leading-relaxed text-slate-600"
              >
                Turn on notifications for daily study reminders. 💛
              </p>

              <div className="mt-5 flex items-center justify-center gap-2 text-xs font-medium text-slate-500">
                <span aria-hidden="true">📚</span>
                <span>Little reminders, brighter learning.</span>
              </div>
            </div>

            <div className="space-y-3 p-5">
              <Button
                className="w-full rounded-2xl py-6 text-sm font-bold shadow-sm"
                style={{
                  background: "#e67e22",
                  color: "#ffffff",
                }}
                onClick={() =>
                  void handleEnableWelcomeNotifications()
                }
              >
                <Bell className="mr-2 h-4 w-4" />
                Enable Notifications
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full rounded-2xl py-5 font-semibold text-slate-500 hover:bg-slate-50"
                onClick={() =>
                  setShowNotificationWelcome(false)
                }
              >
                Maybe later
              </Button>
            </div>
          </motion.div>
        </div>
      )}

      <UnlockDialog
        prompt={unlockPrompt}
        busy={isUnlocking}
        onPayWithKsh={() =>
          unlockPrompt &&
          void unlock(unlockPrompt.materialId, {
            openAfter: unlockPrompt.openAfter,
            allowKsh: true,
          })
        }
        onUnlocked={(id) => {
          setUnlockPrompt(null);
          toast({
            title: "Opened",
            description: "Enjoy your material.",
          });
          onOpenViewer(id);
        }}
        onTopUp={() => {
          setUnlockPrompt(null);
          setIsAddFundsOpen(true);
        }}
        onCancel={() => setUnlockPrompt(null)}
      />

      <AddFundsModal
        isOpen={isAddFundsOpen}
        onClose={() =>
          setIsAddFundsOpen(false)
        }
      />
    </div>
  );
}