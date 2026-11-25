import { lazy, Suspense } from "react";
import { humanizeKey } from "../../lib/analystViz.js";
import { AnalystSql } from "./AnalystSql.jsx";

const AnalystChart = lazy(() =>
  import("./AnalystChart.jsx").then((module) => ({
    default: module.AnalystChart,
  }))
);

const SOURCE_LABELS = {
  governed_metricflow: "Governed by dbt MetricFlow",
};

function paragraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function NoteList({ title, items }) {
  if (items.length === 0) return null;
  return (
    <section className="ai-notes-block">
      <h3 className="ai-section-label">{title}</h3>
      <ul className="ai-notes-list">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function QueryDetails({ query }) {
  if (!query) return null;
  const metrics = Array.isArray(query.metrics) ? query.metrics : [];
  const groupBy = Array.isArray(query.group_by) ? query.group_by : [];

  return (
    <details className="ai-query-details">
      <summary>Query details</summary>
      <dl>
        <div>
          <dt>Metrics</dt>
          <dd>{metrics.length ? metrics.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt>Grouped by</dt>
          <dd>{groupBy.length ? groupBy.join(", ") : "None"}</dd>
        </div>
        <div>
          <dt>Date range</dt>
          <dd>
            {query.start_time && query.end_time
              ? `${query.start_time} to ${query.end_time}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Row limit</dt>
          <dd>{query.limit ?? "—"}</dd>
        </div>
      </dl>
    </details>
  );
}

export function AnalystResult({ result }) {
  const metrics = Array.isArray(result.query?.metrics) ? result.query.metrics : [];
  const sourceLabel = SOURCE_LABELS[result.source] ?? "Governed metrics";

  return (
    <div className="ai-result">
      <section className="ai-answer" aria-label="Answer">
        <p className="ai-section-label">AI-generated summary</p>
        {paragraphs(result.answer).map((text, index) => (
          <p key={index} className="ai-answer-text">
            {text}
          </p>
        ))}
      </section>

      {result.visualization && (
        <Suspense fallback={<p className="ai-viz-empty">Loading chart…</p>}>
          <AnalystChart visualization={result.visualization} />
        </Suspense>
      )}

      {(result.highlights.length > 0 || result.caveats.length > 0) && (
        <div className="ai-notes">
          <NoteList title="Key observations" items={result.highlights} />
          <NoteList title="Notes" items={result.caveats} />
        </div>
      )}

      <footer className="ai-provenance">
        <p className="ai-provenance-line">
          <span className="ai-provenance-source">{sourceLabel}</span>
          {metrics.length > 0 && (
            <span>
              {" · "}
              {metrics.map((metric) => humanizeKey(metric)).join(", ")}
            </span>
          )}
        </p>
        <div className="ai-provenance-actions">
          <AnalystSql sql={result.sql} sqlError={result.sqlError} />
          <QueryDetails query={result.query} />
        </div>
      </footer>
    </div>
  );
}
