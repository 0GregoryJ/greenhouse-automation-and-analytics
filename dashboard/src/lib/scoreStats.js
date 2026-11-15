import {
  expectedBuckets,
  normalizeBucketKey,
} from "./historyStats.js";

/**
 * Summaries for historical environmental scores.
 * Null scores are gaps / incomplete intervals — never treated as zero.
 */

export function summarizeHourlyScores(points) {
  const valid = (points ?? []).filter(
    (point) => point.score !== null && point.score !== undefined
  );

  if (valid.length === 0) {
    return {
      average: null,
      min: null,
      max: null,
      validCount: 0,
      intervalCount: points?.length ?? 0,
      weighting: "hourly",
      firstTimestamp: null,
      latestTimestamp: null,
    };
  }

  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const point of valid) {
    const score = Number(point.score);
    sum += score;
    min = Math.min(min, score);
    max = Math.max(max, score);
  }

  return {
    average: sum / valid.length,
    min,
    max,
    validCount: valid.length,
    intervalCount: points.length,
    weighting: "hourly",
    firstTimestamp: valid[0].timestamp,
    latestTimestamp: valid[valid.length - 1].timestamp,
  };
}

/**
 * Period average for daily points: weight by scored_hours.
 * Min/max use the daily min_score / max_score fields when present.
 */
export function summarizeDailyScores(points) {
  const rows = points ?? [];
  let weightedSum = 0;
  let scoredHours = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let daysWithScore = 0;

  for (const point of rows) {
    const avg = point.score;
    const hours = Number(point.scored_hours) || 0;

    if (avg !== null && avg !== undefined && hours > 0) {
      weightedSum += Number(avg) * hours;
      scoredHours += hours;
      daysWithScore += 1;
    }

    if (point.min_score !== null && point.min_score !== undefined) {
      min = Math.min(min, Number(point.min_score));
    } else if (avg !== null && avg !== undefined) {
      min = Math.min(min, Number(avg));
    }

    if (point.max_score !== null && point.max_score !== undefined) {
      max = Math.max(max, Number(point.max_score));
    } else if (avg !== null && avg !== undefined) {
      max = Math.max(max, Number(avg));
    }
  }

  return {
    average: scoredHours > 0 ? weightedSum / scoredHours : null,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    validCount: scoredHours,
    daysWithScore,
    intervalCount: rows.length,
    weighting: "scored_hours",
    firstTimestamp: rows[0]?.timestamp ?? null,
    latestTimestamp: rows[rows.length - 1]?.timestamp ?? null,
  };
}

export function summarizeScoreSeries(points, resolution) {
  return resolution === "day"
    ? summarizeDailyScores(points)
    : summarizeHourlyScores(points);
}

/**
 * Align sparse score points on a regular grid; null scores stay as gaps.
 */
export function fillScoreTimeline(points, period, resolution, now = Date.now()) {
  const byKey = new Map();

  for (const point of points ?? []) {
    const key = normalizeBucketKey(point.timestamp, resolution);
    if (key) byKey.set(key, point);
  }

  return expectedBuckets(period, resolution, now).map((bucket) => {
    const point = byKey.get(bucket);

    if (!point || point.score === null || point.score === undefined) {
      return {
        timestamp: bucket,
        score: null,
        temperature_score: point?.temperature_score ?? null,
        humidity_score: point?.humidity_score ?? null,
        soil_score: point?.soil_score ?? null,
        status: point?.status ?? null,
        min_score: null,
        max_score: null,
        scored_hours: point?.scored_hours ?? null,
        hours_with_data: point?.hours_with_data ?? null,
        rangeBase: null,
        rangeSpan: null,
        missing: true,
      };
    }

    const score = Number(point.score);
    const minScore =
      point.min_score !== null && point.min_score !== undefined
        ? Number(point.min_score)
        : null;
    const maxScore =
      point.max_score !== null && point.max_score !== undefined
        ? Number(point.max_score)
        : null;

    return {
      timestamp: bucket,
      score,
      temperature_score: point.temperature_score ?? null,
      humidity_score: point.humidity_score ?? null,
      soil_score: point.soil_score ?? null,
      status: point.status ?? null,
      min_score: minScore,
      max_score: maxScore,
      scored_hours: point.scored_hours ?? null,
      hours_with_data: point.hours_with_data ?? null,
      rangeBase: minScore,
      rangeSpan:
        Number.isFinite(minScore) && Number.isFinite(maxScore)
          ? maxScore - minScore
          : null,
      missing: false,
    };
  });
}

/** UI-only category labels — not scientific thresholds. */
export function scoreCategory(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return { key: "unavailable", label: "Unavailable" };
  }

  const value = Number(score);

  if (value >= 80) return { key: "favorable", label: "Favorable" };
  if (value >= 60) return { key: "fair", label: "Fair" };
  if (value >= 40) return { key: "watch", label: "Watch" };
  return { key: "poor", label: "Poor" };
}

export function gatewaysFromReadings(readings) {
  const ids = new Set();

  for (const reading of readings ?? []) {
    if (reading.gateway_id) ids.add(reading.gateway_id);
  }

  return [...ids].sort();
}

export function lowestComponent(components) {
  if (!components || typeof components !== "object") return null;

  const entries = Object.entries(components).filter(
    ([, value]) => value !== null && value !== undefined
  );

  if (entries.length === 0) return null;

  entries.sort((a, b) => Number(a[1]) - Number(b[1]));
  return { name: entries[0][0], score: Number(entries[0][1]) };
}

export const COMPONENT_LABELS = {
  air_temperature: "Temperature",
  relative_humidity: "Humidity",
  soil_moisture: "Soil moisture",
  temperature_score: "Temperature",
  humidity_score: "Humidity",
  soil_score: "Soil moisture",
};
