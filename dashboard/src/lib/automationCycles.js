import { formatActuatorLabel } from "./automationDisplay.js";

function eventTimeMs(event) {
  const value = new Date(event?.timestamp_utc).getTime();
  return Number.isFinite(value) ? value : 0;
}

function compareEvents(a, b) {
  return eventTimeMs(a) - eventTimeMs(b) || String(a.event_id ?? "").localeCompare(String(b.event_id ?? ""));
}

function pushCycle(cycles, { actuator, cycleId, onEvent, offEvent }) {
  const startedAt = onEvent.timestamp_utc;
  if (!startedAt) return;

  if (offEvent?.timestamp_utc) {
    const start = eventTimeMs(onEvent);
    const end = eventTimeMs(offEvent);
    cycles.push({
      id: `cycle:${actuator}:${cycleId}`,
      actuator,
      started_at: startedAt,
      ended_at: offEvent.timestamp_utc,
      duration_seconds: Math.max(0, Math.round((end - start) / 1000)),
      reason: onEvent.reason ?? null,
      complete: true,
    });
    return;
  }

  cycles.push({
    id: `cycle:${actuator}:${cycleId}`,
    actuator,
    started_at: startedAt,
    ended_at: null,
    duration_seconds: null,
    reason: onEvent.reason ?? null,
    complete: false,
  });
}

function pairActuatorCycles(actuator, events) {
  const cycles = [];
  const withId = events.filter((event) => event.cycle_id);
  const withoutId = events.filter((event) => !event.cycle_id);

  const firstOnByCycle = new Map();
  const lastOffByCycle = new Map();

  for (const event of withId) {
    const cycleId = String(event.cycle_id);
    if (event.observed_state === true) {
      if (!firstOnByCycle.has(cycleId)) {
        firstOnByCycle.set(cycleId, event);
      }
    } else {
      lastOffByCycle.set(cycleId, event);
    }
  }

  for (const [cycleId, onEvent] of firstOnByCycle) {
    pushCycle(cycles, {
      actuator,
      cycleId,
      onEvent,
      offEvent: lastOffByCycle.get(cycleId) ?? null,
    });
  }

  let index = 0;
  while (index < withoutId.length) {
    const event = withoutId[index];
    if (event.observed_state !== true) {
      index += 1;
      continue;
    }

    const next = withoutId[index + 1];
    if (next && next.observed_state === false) {
      pushCycle(cycles, {
        actuator,
        cycleId: event.event_id ?? `${eventTimeMs(event)}`,
        onEvent: event,
        offEvent: next,
      });
      index += 2;
      continue;
    }

    pushCycle(cycles, {
      actuator,
      cycleId: event.event_id ?? `${eventTimeMs(event)}`,
      onEvent: event,
      offEvent: null,
    });
    index += 1;
  }

  return cycles;
}

/**
 * Collapse noisy command/state event streams into completed (or open) actuator cycles.
 */
export function consolidateAutomationCycles(events, { limit = 8 } = {}) {
  const stateEvents = (Array.isArray(events) ? events : [])
    .filter(
      (event) =>
        event?.event_type === "state_changed" &&
        (event.actuator === "pump" || event.actuator === "fan") &&
        typeof event.observed_state === "boolean"
    )
    .slice()
    .sort(compareEvents);

  const byActuator = new Map();
  for (const event of stateEvents) {
    if (!byActuator.has(event.actuator)) {
      byActuator.set(event.actuator, []);
    }
    byActuator.get(event.actuator).push(event);
  }

  const cycles = [];
  for (const [actuator, list] of byActuator) {
    cycles.push(...pairActuatorCycles(actuator, list));
  }

  cycles.sort(
    (a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  return cycles.slice(0, limit);
}

export function formatDurationSeconds(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;

  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) {
    return total === 1 ? "1 second" : `${total} seconds`;
  }

  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rem = total % 60;
    if (rem === 0) {
      return minutes === 1 ? "1 minute" : `${minutes} minutes`;
    }
    return `${minutes}m ${rem}s`;
  }

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (minutes === 0) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${hours}h ${minutes}m`;
}

export function formatCycleHeadline(cycle) {
  const actuator = formatActuatorLabel(cycle?.actuator);

  if (!cycle?.complete) {
    return `${actuator} running`;
  }

  const duration = formatDurationSeconds(cycle.duration_seconds);
  if (!duration) {
    return `${actuator} ran`;
  }

  return `${actuator} ran for ${duration}`;
}
