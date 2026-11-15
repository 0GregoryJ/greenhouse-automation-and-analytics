import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fillScoreTimeline,
  scoreCategory,
  summarizeDailyScores,
  summarizeHourlyScores,
} from "./scoreStats.js";
import {
  buildCurrentScoreUrl,
  buildScoreHistoryUrl,
} from "../services/environmentApi.js";

describe("summarizeHourlyScores", () => {
  it("ignores null scores and never treats them as zero", () => {
    const summary = summarizeHourlyScores([
      { timestamp: "a", score: 80 },
      { timestamp: "b", score: null },
      { timestamp: "c", score: 100 },
    ]);

    assert.equal(summary.average, 90);
    assert.equal(summary.min, 80);
    assert.equal(summary.max, 100);
    assert.equal(summary.validCount, 2);
  });
});

describe("summarizeDailyScores", () => {
  it("weights period average by scored_hours", () => {
    const summary = summarizeDailyScores([
      {
        timestamp: "d1",
        score: 100,
        min_score: 90,
        max_score: 100,
        scored_hours: 1,
      },
      {
        timestamp: "d2",
        score: 40,
        min_score: 20,
        max_score: 50,
        scored_hours: 3,
      },
    ]);

    assert.equal(summary.average, 55);
    assert.equal(summary.min, 20);
    assert.equal(summary.max, 100);
    assert.equal(summary.validCount, 4);
    assert.equal(summary.weighting, "scored_hours");
  });
});

describe("fillScoreTimeline", () => {
  it("preserves null scores as gaps", () => {
    const now = Date.parse("2026-11-09T15:00:00.000Z");
    const series = fillScoreTimeline(
      [
        {
          timestamp: "2026-11-09T14:00:00Z",
          score: 88,
          temperature_score: 90,
          humidity_score: 80,
          soil_score: 90,
          status: "complete",
        },
        {
          timestamp: "2026-11-09T13:00:00Z",
          score: null,
          status: "incomplete",
        },
      ],
      "24h",
      "hour",
      now
    );

    const filled = series.find((row) => row.timestamp === "2026-11-09T14:00:00Z");
    const incomplete = series.find(
      (row) => row.timestamp === "2026-11-09T13:00:00Z"
    );
    const gap = series.find((row) => row.timestamp === "2026-11-09T12:00:00Z");

    assert.equal(filled.score, 88);
    assert.equal(filled.missing, false);
    assert.equal(incomplete.score, null);
    assert.equal(incomplete.missing, true);
    assert.equal(gap.score, null);
    assert.equal(gap.missing, true);
  });
});

describe("scoreCategory", () => {
  it("marks null as unavailable", () => {
    assert.equal(scoreCategory(null).key, "unavailable");
    assert.equal(scoreCategory(85).key, "favorable");
  });
});

describe("environment score URLs", () => {
  it("builds current and history query strings", () => {
    const current = buildCurrentScoreUrl(
      "pi-001",
      "https://api.example.com/api/v1/environment/score/current"
    );
    assert.match(current.pathname, /\/api\/v1\/environment\/score\/current$/);
    assert.equal(current.searchParams.get("gateway_id"), "pi-001");

    const history = buildScoreHistoryUrl(
      { gatewayId: "pi-001", period: "7d" },
      "https://api.example.com/api/v1/environment/score/history"
    );
    assert.match(history.pathname, /\/api\/v1\/environment\/score\/history$/);
    assert.equal(history.searchParams.get("gateway_id"), "pi-001");
    assert.equal(history.searchParams.get("period"), "7d");
  });
});
