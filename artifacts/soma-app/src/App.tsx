import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Toaster as HookToaster } from "@/components/ui/toaster";

import { useSomaStore } from "./lib/storage";
import { syncAccount } from "./lib/account";

import WelcomePage from "./pages/WelcomePage";
import { NamePage } from "./pages/NamePage";
import { GradePage } from "./pages/GradePage";
import SchoolPage from "./pages/SchoolPage";
import { IntentPage } from "./pages/IntentPage";
import { PathwayPage } from "./pages/PathwayPage";
import { AvatarPage } from "./pages/AvatarPage";
import { DashboardPage } from "./pages/DashboardPage";
import DeveloperLoginPage from "./pages/DeveloperLoginPage";
import DeveloperDashboardPage from "./pages/DeveloperDashboardPage";

import { ViewerModal } from "./components/ViewerModal";

type PageState =
  | "welcome"
  | "name"
  | "grade"
  | "school"
  | "intent"
  | "pathway"
  | "avatar"
  | "dashboard"
  | "developer-login"
  | "developer-dashboard";

function App() {
  const {
    name,
    grade,
    schoolName,
    studyIntent,
    avatar,
    logout,
  } = useSomaStore();

  /*
   * Start directly on the developer login page when
   * ?developer is present in the URL.
   *
   * This is initialized before the normal student
   * onboarding effect runs, so it cannot be overwritten.
   */
  const [currentPage, setCurrentPage] = useState<PageState>(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.has("developer")) {
      return "developer-login";
    }

    return "welcome";
  });

  const [viewerMaterialId, setViewerMaterialId] =
    useState<string | null>(null);

  const [developerLoggedIn, setDeveloperLoggedIn] =
    useState(false);

  /*
   * Load the student's account when the dashboard is open.
   */
  const onDashboard = currentPage === "dashboard";

  useEffect(() => {
    if (!name || !onDashboard) return;

    const sync = () => {
      syncAccount().catch((error) =>
        console.warn("[SOMA HUB] Account sync failed:", error)
      );
    };

    sync();
    window.addEventListener("online", sync);

    return () =>
      window.removeEventListener("online", sync);
  }, [name, onDashboard]);

  /*
   * Check the normal student onboarding state.
   *
   * Developer pages are completely excluded from this logic.
   */
  useEffect(() => {
    if (
      currentPage === "developer-login" ||
      currentPage === "developer-dashboard" ||
      developerLoggedIn
    ) {
      return;
    }

    if (!name) {
      setCurrentPage("welcome");
      return;
    }

    if (!grade) {
      setCurrentPage("grade");
      return;
    }

    if (!schoolName) {
      setCurrentPage("school");
      return;
    }

    if (!studyIntent) {
      setCurrentPage("intent");
      return;
    }

    if (!avatar) {
      setCurrentPage("avatar");
      return;
    }

    setCurrentPage("dashboard");
  }, [
    name,
    grade,
    schoolName,
    studyIntent,
    avatar,
    developerLoggedIn,
    currentPage,
  ]);

  /*
   * If the student logs out, return to onboarding.
   */
  useEffect(() => {
    if (
      !name &&
      !grade &&
      !schoolName &&
      !studyIntent &&
      !avatar &&
      currentPage === "dashboard"
    ) {
      setCurrentPage("welcome");
      setViewerMaterialId(null);
    }
  }, [
    name,
    grade,
    schoolName,
    studyIntent,
    avatar,
    currentPage,
  ]);

  /*
   * Developer login.
   */
  function openDeveloperLogin() {
    setCurrentPage("developer-login");
  }

  /*
   * Developer successfully logged in.
   */
  function handleDeveloperLogin() {
    setDeveloperLoggedIn(true);
    setCurrentPage("developer-dashboard");
  }

  /*
   * Developer logout.
   */
  function handleDeveloperLogout() {
    setDeveloperLoggedIn(false);
    setCurrentPage("developer-login");
  }

  /*
   * Student logout.
   */
  function handleStudentLogout() {
    logout();
    setViewerMaterialId(null);
    setDeveloperLoggedIn(false);
    setCurrentPage("welcome");
  }

  /*
   * Change grade from the dashboard.
   */
  function handleChangeGrade() {
    setCurrentPage("grade");
  }

  /*
   * Open a study material.
   */
  function handleOpenViewer(materialId: string) {
    setViewerMaterialId(materialId);
  }

  /*
   * Close the study material viewer.
   */
  function handleCloseViewer() {
    setViewerMaterialId(null);
  }

  /*
   * Developer login page.
   */
  if (currentPage === "developer-login") {
    return (
      <>
        <DeveloperLoginPage
          onLogin={handleDeveloperLogin}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  /*
   * Developer dashboard.
   */
  if (currentPage === "developer-dashboard") {
    return (
      <>
        <DeveloperDashboardPage
          onLogout={handleDeveloperLogout}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  /*
   * Normal student welcome page.
   */
  if (currentPage === "welcome") {
    return (
      <>
        <WelcomePage
          onContinue={() => setCurrentPage("name")}
          onDeveloperLogin={openDeveloperLogin}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  if (currentPage === "name") {
    return (
      <>
        <NamePage
          onNext={() => setCurrentPage("grade")}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  if (currentPage === "grade") {
    return (
      <>
        <GradePage
          onNext={() => setCurrentPage("school")}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  if (currentPage === "school") {
    return (
      <>
        <SchoolPage
          onNext={() => setCurrentPage("intent")}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  if (currentPage === "intent") {
    return (
      <>
        <IntentPage
          onNext={() => setCurrentPage("pathway")}
          onBack={() => setCurrentPage("school")}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  if (currentPage === "pathway") {
    return (
      <>
        <PathwayPage
          onNext={() => setCurrentPage("avatar")}
          onBack={() => setCurrentPage("intent")}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  if (currentPage === "avatar") {
    return (
      <>
        <AvatarPage
          onNext={() => setCurrentPage("dashboard")}
        />

        <Toaster position="top-center" />
      </>
    );
  }

  /*
   * Main student dashboard.
   */
  return (
    <>
      <DashboardPage
        onOpenViewer={handleOpenViewer}
        onChangeGrade={handleChangeGrade}
        onLogout={handleStudentLogout}
      />

      {viewerMaterialId && (
        <ViewerModal
          materialId={viewerMaterialId}
          onClose={handleCloseViewer}
        />
      )}

      <Toaster position="top-center" />
      <HookToaster />
    </>
  );
}

export default App;