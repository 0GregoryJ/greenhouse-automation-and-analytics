import { useMemo } from "react";
import {
  formatCycleHeadline,
  MIN_DISPLAYED_AUTOMATION_CYCLES,
  selectDisplayedAutomationCycles,
} from "../../lib/automationCycles.js";
import { formatAutomationTime } from "../../lib/automationDisplay.js";
import { IconArrowUpRight, IconDroplet, IconFan } from "../layout/NavIcons.jsx";

function ActuatorIcon({ actuator }) {
  if (actuator === "fan") return <IconFan className="auto-item-icon" />;
  return <IconDroplet className="auto-item-icon" />;
}

export function RecentAutomations({
  events,
  historyCycles = [],
  historyStatus = "idle",
  status,
  error,
  now,
  style,
  onOpenAnalytics,
}) {
  const cycles = useMemo(
    () => selectDisplayedAutomationCycles(events, historyCycles),
    [events, historyCycles]
  );
  const loaded = status !== "loading" || events.length > 0;
  const awaitingHistory =
    historyStatus === "loading" &&
    cycles.length < MIN_DISPLAYED_AUTOMATION_CYCLES;

  return (
    <section
      className="auto-panel"
      aria-label="Recent automations"
      style={style}
    >
      <header className="auto-panel-head">
        <div className="auto-panel-heading">
          <h2>Recent automations</h2>
          <p className="auto-panel-copy">Last 5 fan and pump cycles</p>
        </div>
        {typeof onOpenAnalytics === "function" && (
          <button
            type="button"
            className="auto-panel-link"
            onClick={onOpenAnalytics}
            aria-label="Open automation analytics"
            title="Automation analytics"
          >
            <IconArrowUpRight className="auto-panel-link-icon" />
          </button>
        )}
      </header>

      {error && cycles.length === 0 && !awaitingHistory && (
        <p className="auto-empty" role="status">
          Automation feed unavailable.
        </p>
      )}

      {((!loaded && !error) || (awaitingHistory && cycles.length === 0)) && (
        <ul className="auto-list" aria-hidden="true">
          {Array.from({ length: MIN_DISPLAYED_AUTOMATION_CYCLES }, (_, index) => (
            <li key={index} className="auto-item auto-item-skeleton" />
          ))}
        </ul>
      )}

      {loaded && cycles.length === 0 && !error && !awaitingHistory && (
        <p className="auto-empty">No automation cycles yet.</p>
      )}

      {cycles.length > 0 && (
        <ul className="auto-list">
          {cycles.map((cycle) => (
            <li key={cycle.id} className="auto-item">
              <span
                className={`auto-item-mark auto-item-mark-${cycle.actuator ?? "pump"}`}
                aria-hidden="true"
              >
                <ActuatorIcon actuator={cycle.actuator} />
              </span>
              <div className="auto-item-body">
                <p className="auto-item-title">{formatCycleHeadline(cycle)}</p>
                {cycle.reason && (
                  <p className="auto-item-reason">{cycle.reason}</p>
                )}
              </div>
              <time className="auto-item-time" dateTime={cycle.started_at}>
                {formatAutomationTime(cycle.started_at, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
