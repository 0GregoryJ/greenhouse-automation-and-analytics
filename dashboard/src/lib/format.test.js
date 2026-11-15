import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chartXAxisInterval,
  celsiusToFahrenheit,
  formatChartTick,
  formatChartTooltipTime,
  formatValue,
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
