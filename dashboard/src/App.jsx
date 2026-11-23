import { useEffect, useState } from "react";
import "./App.css";
import { Sidebar } from "./components/layout/Sidebar.jsx";
import { useLiveReadings } from "./hooks/useLiveReadings.js";
import { AboutPage } from "./pages/AboutPage.jsx";
import { AnalyticsPage } from "./pages/AnalyticsPage.jsx";
import { ControlPage } from "./pages/ControlPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";

export default function App() {
  const [page, setPage] = useState("home");
  const [now, setNow] = useState(() => Date.now());
  const { readings, status, error, lastFetchedAt } = useLiveReadings({
    enabled: true,
  });

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} />

      <main className="app-main">
        {page === "home" && (
          <HomePage
            readings={readings}
            status={status}
            error={error}
            lastFetchedAt={lastFetchedAt}
            now={now}
          />
        )}
        {page === "control" && <ControlPage />}
        {page === "analytics" && (
          <AnalyticsPage readings={readings} now={now} />
        )}
        {page === "about" && <AboutPage />}
      </main>
    </div>
  );
}
