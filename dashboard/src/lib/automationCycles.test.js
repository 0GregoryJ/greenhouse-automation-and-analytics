import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consolidateAutomationCycles,
  formatCycleHeadline,
  formatDurationSeconds,
  MIN_DISPLAYED_AUTOMATION_CYCLES,
  selectDisplayedAutomationCycles,
} from "./automationCycles.js";

describe("consolidateAutomationCycles", () => {
  it("pairs pump on/off by cycle_id and ignores command noise", () => {
    const cycles = consolidateAutomationCycles([
      {
        event_id: "1",
        actuator: "pump",
        event_type: "command_issued",
        desired_state: true,
        reason: "soil_moisture_low",
        timestamp_utc: "2026-11-23T10:00:00Z",
      },
      {
        event_id: "2",
        actuator: "pump",
        event_type: "state_changed",
        observed_state: true,
        cycle_id: "abc",
        reason: "shelly_status",
        timestamp_utc: "2026-11-23T10:00:01Z",
      },
      {
        event_id: "3",
        actuator: "pump",
        event_type: "command_acknowledged",
        timestamp_utc: "2026-11-23T10:00:02Z",
      },
      {
        event_id: "4",
        actuator: "pump",
        event_type: "state_changed",
        observed_state: false,
        cycle_id: "abc",
        timestamp_utc: "2026-11-23T10:00:07Z",
      },
    ]);

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].actuator, "pump");
    assert.equal(cycles[0].complete, true);
    assert.equal(cycles[0].duration_seconds, 6);
    assert.equal(formatCycleHeadline(cycles[0]), "Pump ran for 6 seconds");
  });

  it("pairs sequential fan states without cycle_id", () => {
    const cycles = consolidateAutomationCycles([
      {
        event_id: "a",
        actuator: "fan",
        event_type: "state_changed",
        observed_state: true,
        reason: "temperature_high",
        timestamp_utc: "2026-11-23T11:00:00Z",
      },
      {
        event_id: "b",
        actuator: "fan",
        event_type: "state_changed",
        observed_state: false,
        timestamp_utc: "2026-11-23T11:02:00Z",
      },
    ]);

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].duration_seconds, 120);
    assert.equal(formatCycleHeadline(cycles[0]), "Fan ran for 2 minutes");
  });
});

function liveOnOff(actuator, cycleId, startedAt) {
  return [
    {
      event_id: `${cycleId}-on`,
      actuator,
      event_type: "state_changed",
      observed_state: true,
      cycle_id: cycleId,
      reason: "shelly_status",
      timestamp_utc: startedAt,
    },
    {
      event_id: `${cycleId}-off`,
      actuator,
      event_type: "state_changed",
      observed_state: false,
      cycle_id: cycleId,
      timestamp_utc: new Date(new Date(startedAt).getTime() + 6000).toISOString(),
    },
  ];
}

describe("selectDisplayedAutomationCycles", () => {
  it("fills out the last five from warehouse cycles when the live feed is short", () => {
    const events = liveOnOff("pump", "live-1", "2026-11-24T12:00:00Z");
    const history = [1, 2, 3, 4].map((daysAgo) => ({
      cycle_id: `old-${daysAgo}`,
      actuator: "fan",
      started_at: `2026-11-${String(24 - daysAgo).padStart(2, "0")}T08:00:00Z`,
      ended_at: `2026-11-${String(24 - daysAgo).padStart(2, "0")}T08:02:00Z`,
      duration_seconds: 120,
      reason: "temperature_high",
    }));

    const cycles = selectDisplayedAutomationCycles(events, history);

    assert.equal(cycles.length, MIN_DISPLAYED_AUTOMATION_CYCLES);
    assert.equal(cycles[0].id, "cycle:pump:live-1");
    assert.equal(cycles[0].complete, true);
    assert.deepEqual(
      cycles.slice(1).map((cycle) => cycle.cycle_id),
      ["old-1", "old-2", "old-3", "old-4"]
    );
  });

  it("keeps a completed warehouse cycle when live only still has the on event", () => {
    const events = [
      {
        event_id: "on",
        actuator: "pump",
        event_type: "state_changed",
        observed_state: true,
        cycle_id: "abc",
        reason: "shelly_status",
        timestamp_utc: "2026-11-24T10:00:01Z",
      },
    ];
    const history = [
      {
        cycle_id: "abc",
        actuator: "pump",
        started_at: "2026-11-24T10:00:01.500Z",
        ended_at: "2026-11-24T10:00:07Z",
        duration_seconds: 6,
        reason: "shelly_status",
      },
    ];

    const cycles = selectDisplayedAutomationCycles(events, history);

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].complete, true);
    assert.equal(cycles[0].duration_seconds, 6);
    assert.equal(formatCycleHeadline(cycles[0]), "Pump ran for 6 seconds");
  });

  it("returns every cycle when fewer than five exist", () => {
    const history = [
      {
        cycle_id: "only",
        actuator: "pump",
        started_at: "2026-11-20T08:00:00Z",
        ended_at: "2026-11-20T08:01:00Z",
        duration_seconds: 60,
        reason: "soil_moisture_low",
      },
    ];

    const cycles = selectDisplayedAutomationCycles([], history);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].reason, "soil_moisture_low");
  });
});

describe("formatDurationSeconds", () => {
  it("formats short and minute durations", () => {
    assert.equal(formatDurationSeconds(1), "1 second");
    assert.equal(formatDurationSeconds(6), "6 seconds");
    assert.equal(formatDurationSeconds(60), "1 minute");
    assert.equal(formatDurationSeconds(90), "1m 30s");
  });
});
