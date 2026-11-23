import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatActuatorLabel,
  formatAutomationHeadline,
} from "./automationDisplay.js";

describe("formatAutomationHeadline", () => {
  it("describes observed pump state changes", () => {
    assert.equal(
      formatAutomationHeadline({
        actuator: "pump",
        event_type: "state_changed",
        observed_state: true,
      }),
      "Pump turned on"
    );
  });

  it("falls back to event type labels", () => {
    assert.equal(
      formatAutomationHeadline({
        actuator: "fan",
        event_type: "command_failed",
      }),
      "Fan · failed"
    );
  });
});

describe("formatActuatorLabel", () => {
  it("capitalizes actuator names", () => {
    assert.equal(formatActuatorLabel("pump"), "Pump");
  });
});
