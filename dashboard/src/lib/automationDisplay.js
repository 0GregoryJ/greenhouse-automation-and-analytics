import { DISPLAY_TIME_ZONE } from "./format.js";

const EVENT_LABELS = {
  command_issued: "command issued",
  command_acknowledged: "acknowledged",
  command_failed: "failed",
  state_changed: "state changed",
};

export function formatActuatorLabel(actuator) {
  if (!actuator) return "Actuator";
  return String(actuator).charAt(0).toUpperCase() + String(actuator).slice(1);
}

export function formatAutomationHeadline(event) {
  const actuator = formatActuatorLabel(event?.actuator);
  const type = event?.event_type;

  if (type === "state_changed" && typeof event?.observed_state === "boolean") {
    return `${actuator} turned ${event.observed_state ? "on" : "off"}`;
  }

  if (type === "command_issued" && typeof event?.desired_state === "boolean") {
    return `${actuator} ${event.desired_state ? "on" : "off"} commanded`;
  }

  const typeLabel = EVENT_LABELS[type] ?? String(type ?? "event").replace(/_/g, " ");
  return `${actuator} · ${typeLabel}`;
}

export function formatAutomationTime(timestampUtc, now = Date.now()) {
  if (!timestampUtc) return "—";

  const then = new Date(timestampUtc).getTime();
  if (!Number.isFinite(then)) return "—";

  const deltaSec = Math.max(0, Math.round((now - then) / 1000));
  if (deltaSec < 60) return "Just now";
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;

  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(then));
}
