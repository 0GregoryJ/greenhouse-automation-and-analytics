import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consolidateAutomationCycles,
  formatCycleHeadline,
  formatDurationSeconds,
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

describe("formatDurationSeconds", () => {
  it("formats short and minute durations", () => {
    assert.equal(formatDurationSeconds(1), "1 second");
    assert.equal(formatDurationSeconds(6), "6 seconds");
    assert.equal(formatDurationSeconds(60), "1 minute");
    assert.equal(formatDurationSeconds(90), "1m 30s");
  });
});
