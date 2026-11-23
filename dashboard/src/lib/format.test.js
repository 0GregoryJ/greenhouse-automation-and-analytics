import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chartXAxisInterval,
  celsiusToFahrenheit,
  formatChartTick,
  formatChartTooltipTime,
  formatLiveReading,
  formatMoistureState,
  formatValue,
  liveDisplayValue,
} from "./format.js";

describe("formatValue temperature", () => {
  it("converts celsius API values to Fahrenheit for display", () => {
    const formatted = formatValue({ value: 20, unit: "celsius" });

    assert.equal(formatted.number, "68.0");
    assert.equal(formatted.suffix, "°F");
  });
});

describe("celsiusToFahrenheit", () => {
  it("uses the standard conversion", () => {
    assert.equal(celsiusToFahrenheit(0), 32);
    assert.equal(celsiusToFahrenheit(100), 212);
  });
});

describe("formatChartTooltipTime", () => {
  it("labels timestamps in Pacific time", () => {
    // 2026-11-08T20:00:00Z == 12:00 PM PST
    const label = formatChartTooltipTime("2026-11-08T20:00:00Z", "hour");

    assert.match(label, /12:00\s*PM/);
    assert.match(label, /PST|PDT|PT/);
    assert.doesNotMatch(label, /UTC/);
  });
});

describe("chart axis ticks", () => {
  it("spaces 7d hourly labels about once per day", () => {
    assert.equal(chartXAxisInterval("7d", "hour"), 23);
  });

  it("uses date-only labels for 7d hourly ticks", () => {
    const label = formatChartTick("2026-11-08T20:00:00Z", "hour", "7d");

    assert.match(label, /Nov/);
    assert.doesNotMatch(label, /PM|AM|:/);
  });
});

describe("liveDisplayValue", () => {
  it("uses raw_value for ordinary readings", () => {
    const display = liveDisplayValue({
      measurement_type: "air_temperature",
      raw_value: 22.5,
      unit: "celsius",
    });

    assert.equal(display.value, 22.5);
    assert.equal(display.unit, "celsius");
    assert.equal(display.isCalibratedMoisture, false);
  });

  it("prefers calibrated soil moisture percent and state", () => {
    const display = liveDisplayValue({
      measurement_type: "soil_moisture",
      raw_value: 1010,
      unit: "raw_capacitance",
      calibrated_pct: 60,
      state: "wet-like",
    });

    assert.equal(display.value, 60);
    assert.equal(display.unit, "percent");
    assert.equal(display.state, "wet-like");
    assert.equal(display.isCalibratedMoisture, true);
  });
});

describe("formatLiveReading", () => {
  it("formats calibrated moisture as an integer percent", () => {
    const formatted = formatLiveReading({
      measurement_type: "soil_moisture",
      raw_value: 1010,
      unit: "raw_capacitance",
      calibrated_pct: 60,
      state: "wet-like",
    });

    assert.equal(formatted.number, "60");
    assert.equal(formatted.suffix, "%");
  });
});

describe("formatMoistureState", () => {
  it("labels wet-like and dry-like states", () => {
    assert.deepEqual(formatMoistureState("wet-like"), {
      key: "wet",
      label: "Wet-like",
    });
    assert.deepEqual(formatMoistureState("dry-like"), {
      key: "dry",
      label: "Dry-like",
    });
  });
});
