import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAnalystNumber,
  formatTimeTick,
  granularityForKey,
  humanizeKey,
  parseTimeValue,
  prepareVisualization,
  toNumberOrNull,
  unitForKey,
} from "./analystViz.js";

describe("humanizeKey", () => {
  it("humanizes uppercase metric columns with units", () => {
    assert.equal(humanizeKey("AVG_SOIL_MOISTURE_PCT"), "Avg soil moisture (%)");
    assert.equal(humanizeKey("avg_temperature_c"), "Avg temperature (°C)");
    assert.equal(humanizeKey("pct_humidity_readings_in_range"), "Humidity readings in range (%)");
  });

  it("drops entity prefixes from dimensions", () => {
    assert.equal(humanizeKey("METRIC_TIME__DAY"), "Day");
    assert.equal(humanizeKey("sensor_hour__sensor_id"), "Sensor ID");
  });
});

describe("unit and granularity detection", () => {
  it("infers units from metric names", () => {
    assert.equal(unitForKey("avg_pump_cycle_duration_seconds"), "s");
    assert.equal(unitForKey("fan_cycle_count"), null);
  });

  it("reads granularity from metric_time suffix", () => {
    assert.equal(granularityForKey("METRIC_TIME__HOUR"), "hour");
    assert.equal(granularityForKey("sensor_hour__gateway_id"), null);
  });
});

describe("parseTimeValue", () => {
  it("treats naive warehouse timestamps as Pacific wall time", () => {
    assert.equal(parseTimeValue("2026-11-24 00:00:00"), Date.UTC(2026, 10, 24, 8));
    assert.equal(parseTimeValue("2026-11-24"), Date.UTC(2026, 10, 24, 8));
  });

  it("rejects non-dates", () => {
    assert.equal(parseTimeValue("gw-01"), null);
    assert.equal(parseTimeValue(42), null);
  });
});

describe("toNumberOrNull", () => {
  it("preserves nulls instead of zero", () => {
    assert.equal(toNumberOrNull(null), null);
    assert.equal(toNumberOrNull(""), null);
    assert.equal(toNumberOrNull("54.9"), 54.9);
    assert.equal(toNumberOrNull(0), 0);
  });
});

describe("prepareVisualization", () => {
  const lineViz = {
    type: "line",
    title: "Average Soil Moisture",
    xKey: "METRIC_TIME__DAY",
    series: [{ dataKey: "AVG_SOIL_MOISTURE_PCT", label: "avg_soil_moisture_pct" }],
    columns: ["METRIC_TIME__DAY", "AVG_SOIL_MOISTURE_PCT"],
    rows: [
      { METRIC_TIME__DAY: "2026-11-24 00:00:00", AVG_SOIL_MOISTURE_PCT: 54.93 },
      { METRIC_TIME__DAY: "2026-11-22 00:00:00", AVG_SOIL_MOISTURE_PCT: null },
      { METRIC_TIME__DAY: "2026-11-23 00:00:00", AVG_SOIL_MOISTURE_PCT: "50.1" },
    ],
  };

  it("sorts time series chronologically and keeps nulls", () => {
    const prepared = prepareVisualization(lineViz);
    assert.equal(prepared.mode, "line");
    assert.equal(prepared.isTime, true);
    assert.equal(prepared.granularity, "day");
    assert.deepEqual(
      prepared.rows.map((row) => row.AVG_SOIL_MOISTURE_PCT),
      [null, 50.1, 54.93]
    );
    assert.equal(prepared.series[0].label, "Avg soil moisture (%)");
  });

  it("returns none for empty rows", () => {
    assert.equal(prepareVisualization({ ...lineViz, rows: [] }).mode, "none");
    assert.equal(prepareVisualization({ ...lineViz, type: "none" }).mode, "none");
  });

  it("falls back to table when a chart has no x axis", () => {
    const prepared = prepareVisualization({ ...lineViz, xKey: null });
    assert.equal(prepared.mode, "table");
  });

  it("uses KPI mode for a single scalar row", () => {
    const prepared = prepareVisualization({
      type: "table",
      xKey: null,
      series: [{ dataKey: "FAN_CYCLE_COUNT", label: "fan_cycle_count" }],
      columns: ["FAN_CYCLE_COUNT"],
      rows: [{ FAN_CYCLE_COUNT: 12 }],
    });
    assert.equal(prepared.mode, "kpi");
  });
});

describe("formatting", () => {
  it("formats numbers with units", () => {
    assert.equal(formatAnalystNumber(54.931, "%"), "54.93%");
    assert.equal(formatAnalystNumber(null, "%"), "—");
    assert.equal(formatAnalystNumber(1200, "s"), "1,200 s");
  });

  it("formats day ticks in Pacific time", () => {
    assert.equal(formatTimeTick("2026-11-24 00:00:00", "day"), "Nov 24");
  });
});
