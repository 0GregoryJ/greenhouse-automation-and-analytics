import { lazy, Suspense } from "react";
import { AiAnalystPanel } from "../components/ai/AiAnalystPanel.jsx";

const HistoryView = lazy(() =>
  import("../components/history/HistoryView.jsx").then((module) => ({
    default: module.HistoryView,
  }))
);

const ANALYTICS_PROMPTS = [
  "Summarize environment score for the selected period",
  "Did irrigation improve soil moisture afterward?",
  "Which hours were farthest from target conditions?",
];

export function AnalyticsPage({ readings, now, initialMode = "score" }) {
  return (
    <section className="view analytics-view" aria-label="Analytics">
      <div className="view-toolbar">
        <div>
          <h2 className="view-title">Analytics</h2>
          <p className="view-copy">
            Warehouse trends for conditions, sensors, and automation cycles.
          </p>
        </div>
        <span className="pill pill-idle">
          <span className="pill-dot" />
          Warehouse
        </span>
      </div>

      <div className="analytics-ai-slot">
        <AiAnalystPanel
          variant="compact"
          title="Greenhouse analyst"
          description="Ask questions against governed metrics for trustworthy, AI-powered insights into greenhouse data."
          prompts={ANALYTICS_PROMPTS}
        />
      </div>

      <Suspense
        fallback={
          <div className="chart-shell chart-shell-loading" aria-busy="true">
            <div className="chart-skeleton" />
            <p>Loading historical analytics…</p>
          </div>
        }
      >
        <HistoryView
          key={initialMode}
          readings={readings}
          now={now}
          embedded
          initialMode={initialMode}
        />
      </Suspense>
    </section>
  );
}
