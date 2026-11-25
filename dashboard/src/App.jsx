import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { Sidebar } from "./components/layout/Sidebar.jsx";
import { useLiveReadings } from "./hooks/useLiveReadings.js";
import { AboutPage } from "./pages/AboutPage.jsx";
import { AnalyticsPage } from "./pages/AnalyticsPage.jsx";
import { ControlPage } from "./pages/ControlPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";

const SIDEBAR_KEY = "greenhouse.sidebarCollapsed";

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const [page, setPage] = useState("home");
  const [analyticsMode, setAnalyticsMode] = useState("score");
  const [analystIntent, setAnalystIntent] = useState(null);
  const analystIntentIdRef = useRef(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [now, setNow] = useState(() => Date.now());
  const { readings, status, error, lastFetchedAt } = useLiveReadings({
    enabled: true,
  });

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function navigate(nextPage) {
    setPage(nextPage);
    setAnalystIntent(null);
    if (nextPage === "analytics") {
      setAnalyticsMode("score");
    }
  }

  function openAutomationAnalytics() {
    setAnalyticsMode("automations");
    setAnalystIntent(null);
    setPage("analytics");
  }

  const openAnalyst = useCallback((question) => {
    analystIntentIdRef.current += 1;
    setAnalystIntent({
      id: analystIntentIdRef.current,
      question: typeof question === "string" ? question : null,
    });
    setAnalyticsMode("score");
    setPage("analytics");
  }, []);

  const clearAnalystIntent = useCallback(() => setAnalystIntent(null), []);

  return (
    <div className={sidebarCollapsed ? "app-shell is-collapsed" : "app-shell"}>
      <Sidebar
        page={page}
        onNavigate={navigate}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
      />

      <main className="app-main">
        {page === "home" && (
          <HomePage
            readings={readings}
            status={status}
            error={error}
            lastFetchedAt={lastFetchedAt}
            now={now}
            onOpenAutomationAnalytics={openAutomationAnalytics}
            onOpenAnalyst={openAnalyst}
          />
        )}
        {page === "control" && <ControlPage />}
        {page === "analytics" && (
          <AnalyticsPage
            readings={readings}
            now={now}
            initialMode={analyticsMode}
            analystIntent={analystIntent}
            onAnalystIntentHandled={clearAnalystIntent}
          />
        )}
        {page === "about" && <AboutPage />}
      </main>
    </div>
  );
}
