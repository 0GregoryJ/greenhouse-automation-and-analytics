import {
  formatAutomationHeadline,
  formatAutomationTime,
} from "../../lib/automationDisplay.js";
import { IconDroplet, IconFan } from "../layout/NavIcons.jsx";

function ActuatorIcon({ actuator }) {
  if (actuator === "fan") return <IconFan className="auto-item-icon" />;
  return <IconDroplet className="auto-item-icon" />;
}

export function RecentAutomations({ events, status, error, now, style }) {
  const loaded = status !== "loading" || events.length > 0;

  return (
    <section
      className="auto-panel"
      aria-label="Recent automations"
      style={style}
    >
      <header className="auto-panel-head">
        <h2>Recent automations</h2>
        <p className="auto-panel-copy">Latest fan and pump events</p>
      </header>

      {error && events.length === 0 && (
        <p className="auto-empty" role="status">
          Automation feed unavailable.
        </p>
      )}

      {!loaded && !error && (
        <ul className="auto-list" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="auto-item auto-item-skeleton" />
          ))}
        </ul>
      )}

      {loaded && events.length === 0 && !error && (
        <p className="auto-empty">No automation events yet.</p>
      )}

      {events.length > 0 && (
        <ul className="auto-list">
          {events.map((event) => (
            <li
              key={event.event_id ?? `${event.actuator}-${event.timestamp_utc}`}
              className="auto-item"
            >
              <span
                className={`auto-item-mark auto-item-mark-${event.actuator ?? "pump"}`}
                aria-hidden="true"
              >
                <ActuatorIcon actuator={event.actuator} />
              </span>
              <div className="auto-item-body">
                <p className="auto-item-title">
                  {formatAutomationHeadline(event)}
                </p>
                {event.reason && (
                  <p className="auto-item-reason">{event.reason}</p>
                )}
              </div>
              <time
                className="auto-item-time"
                dateTime={event.timestamp_utc}
              >
                {formatAutomationTime(event.timestamp_utc, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
