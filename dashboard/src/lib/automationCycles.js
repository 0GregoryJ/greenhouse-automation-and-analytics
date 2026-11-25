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

/** Home automations list should not shrink below this when older cycles exist. */
export const MIN_DISPLAYED_AUTOMATION_CYCLES = 5;

function cycleIdFromDisplayId(id) {
  if (typeof id !== "string" || !id.startsWith("cycle:")) return null;
  const parts = id.split(":");
  if (parts.length < 3) return null;
  return parts.slice(2).join(":");
}

function identityKeys(cycle) {
  const keys = [];
  const cycleId = cycle.cycle_id ?? cycleIdFromDisplayId(cycle.id);
  if (cycleId) keys.push(`cycle:${cycle.actuator}:${cycleId}`);

  const startedMs = new Date(cycle.started_at).getTime();
  if (Number.isFinite(startedMs)) {
    keys.push(`start:${cycle.actuator}:${Math.floor(startedMs / 1000)}`);
  }

  return keys;
}

function chooseCycle(existing, incoming) {
  if (!existing) return incoming;
  if (incoming.complete && !existing.complete) return incoming;
  if (existing.complete && !incoming.complete) return existing;
  return incoming;
}

function normalizeHistoryCycle(cycle) {
  if (cycle?.actuator !== "pump" && cycle?.actuator !== "fan") return null;

  const startedAt = cycle.started_at;
  if (!startedAt) return null;

  const cycleId = cycle.cycle_id == null ? null : String(cycle.cycle_id);
  const endedAt = cycle.ended_at ?? null;
  const complete = cycle.complete === true || endedAt != null;

  return {
    id: cycle.id ?? `cycle:${cycle.actuator}:${cycleId ?? startedAt}`,
    actuator: cycle.actuator,
    cycle_id: cycleId,
    started_at: startedAt,
    ended_at: complete ? endedAt : null,
    duration_seconds:
      cycle.duration_seconds == null || !Number.isFinite(Number(cycle.duration_seconds))
        ? null
        : Number(cycle.duration_seconds),
    reason: cycle.reason ?? null,
    complete,
  };
}

/**
 * Newest cycles for the home panel.
 * Live events win when they describe the same run, except an open live cycle
 * does not hide a completed warehouse cycle. Returns the newest `count` cycles
 * when that many exist across both sources.
 */
export function selectDisplayedAutomationCycles(
  events,
  historyCycles = [],
  { count = MIN_DISPLAYED_AUTOMATION_CYCLES } = {}
) {
  const live = consolidateAutomationCycles(events, { limit: 100 }).map((cycle) => ({
    ...cycle,
    cycle_id: cycleIdFromDisplayId(cycle.id),
  }));
  const history = (Array.isArray(historyCycles) ? historyCycles : [])
    .map(normalizeHistoryCycle)
    .filter(Boolean);

  const groups = [];
  const keyToGroup = new Map();

  const add = (cycle) => {
    const keys = identityKeys(cycle);
    let group = null;
    for (const key of keys) {
      if (keyToGroup.has(key)) {
        group = keyToGroup.get(key);
        break;
      }
    }

    if (!group) {
      group = { cycle };
      groups.push(group);
    } else {
      group.cycle = chooseCycle(group.cycle, cycle);
    }

    for (const key of new Set([...keys, ...identityKeys(group.cycle)])) {
      keyToGroup.set(key, group);
    }
  };

  for (const cycle of history) add(cycle);
  for (const cycle of live) add(cycle);

  const merged = groups.map((group) => group.cycle);
  merged.sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  const limit = Number.isFinite(count)
    ? Math.max(0, count)
    : MIN_DISPLAYED_AUTOMATION_CYCLES;
  return merged.slice(0, limit);
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
