import { lazy, Suspense } from "react";
import { AiAnalystPanel } from "../components/ai/AiAnalystPanel.jsx";
import { ComingSoonPanel } from "../components/shared/ComingSoonPanel.jsx";

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

export function AnalyticsPage({ readings, now }) {
  return (
    <section className="view analytics-view" aria-label="Analytics">
      <div className="view-toolbar">
        <div>
          <h2 className="view-title">Analytics</h2>
          <p className="view-copy">
            Warehouse trends for conditions and sensors. Automation analytics
            and natural-language exploration are on the way.
          </p>
        </div>
        <span className="pill pill-idle">
          <span className="pill-dot" />
          Warehouse
        </span>
      </div>

      <div className="analytics-soon-grid">
        <AiAnalystPanel
          variant="compact"
          title="Analytics analyst"
          description="Query historical score and sensor marts in plain language once the semantic layer is connected."
          prompts={ANALYTICS_PROMPTS}
        />
        <ComingSoonPanel
          title="Automation analytics"
          description="Counts, timing, and outcome charts for fan and pump events need dbt marts on automation topics. Placeholder until those models ship."
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
        <HistoryView readings={readings} now={now} embedded />
      </Suspense>
    </section>
  );
}
