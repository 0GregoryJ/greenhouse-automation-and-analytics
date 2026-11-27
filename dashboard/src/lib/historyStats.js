import { DISPLAY_TIME_ZONE, formatValue } from "./format.js";

/**
 * Weighted average of aggregated points: sum(avg * count) / sum(count).
 * Min/max are extrema of the point-level min/max fields.
 */
export function summarizePoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return {
      weightedAvg: null,
      min: null,
      max: null,
      totalReadings: 0,
      intervalCount: 0,
      firstTimestamp: null,
      latestTimestamp: null,
      unit: null,
    };
  }

  let weightedSum = 0;
  let totalReadings = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const units = new Set();

  for (const point of points) {
    const count = Number(point.count) || 0;
    const avg = Number(point.avg);
    const pointMin = Number(point.min);
    const pointMax = Number(point.max);

    if (count > 0 && Number.isFinite(avg)) {
      weightedSum += avg * count;
      totalReadings += count;
    }

    if (Number.isFinite(pointMin)) min = Math.min(min, pointMin);
    if (Number.isFinite(pointMax)) max = Math.max(max, pointMax);
    if (point.unit) units.add(point.unit);
  }

  return {
    weightedAvg: totalReadings > 0 ? weightedSum / totalReadings : null,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    totalReadings,
    intervalCount: points.length,
    firstTimestamp: points[0]?.timestamp ?? null,
    latestTimestamp: points[points.length - 1]?.timestamp ?? null,
    unit: units.size === 1 ? [...units][0] : null,
  };
}

export function buildInsights(points, summary) {
  if (!points?.length || !summary) return [];

  const insights = [];
  const unit = summary.unit;

  const lowest = points.reduce((best, point) =>
    point.min < best.min ? point : best
  );
  const highest = points.reduce((best, point) =>
    point.max > best.max ? point : best
  );

  insights.push({
    key: "low",
    label: "Lowest interval",
    detail: formatInsightValue(lowest.min, unit),
    meta: lowest.timestamp,
  });

  insights.push({
    key: "high",
    label: "Highest interval",
    detail: formatInsightValue(highest.max, unit),
    meta: highest.timestamp,
  });

  const first = points[0];
  const last = points[points.length - 1];

  if (
    first &&
    last &&
    first !== last &&
    Number.isFinite(first.avg) &&
    Number.isFinite(last.avg)
  ) {
    const delta = last.avg - first.avg;
    const direction =
      Math.abs(delta) < 1e-9
        ? "unchanged"
        : delta > 0
          ? "higher"
          : "lower";

    insights.push({
      key: "change",
      label: "Start → end of period",
      detail:
        direction === "unchanged"
          ? "No change between first and last intervals"
          : `${formatInsightValue(Math.abs(delta), unit)} ${direction}`,
      meta: "Compares the first and last aggregated intervals, not a live reading",
    });
  }

  return insights;
}

function formatInsightValue(value, unit) {
  const { number, suffix } = formatValue({ value, unit });
  return suffix ? `${number} ${suffix}` : number;
}

function pacificParts(date) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

function pacificOffsetMs(date) {
  const parts = pacificParts(date);
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wallAsUtc - date.getTime();
}

/** Start of the Pacific hour or calendar day that contains `date`, as an instant. */
function startOfPacificBucket(date, resolution) {
  const parts = pacificParts(date);
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    resolution === "day" ? 0 : Number(parts.hour),
    0,
    0,
  );
  return new Date(wallAsUtc - pacificOffsetMs(date));
}

function bucketIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Align sparse API points onto Pacific hour or day buckets so chart gaps stay
 * visible. Missing buckets become null values (Recharts connectNulls={false}).
 */
export function fillTimeline(points, period, resolution, now = Date.now()) {
  const byKey = new Map();

  for (const point of points ?? []) {
    const key = normalizeBucketKey(point.timestamp, resolution);
    if (key) byKey.set(key, point);
  }

  const buckets = expectedBuckets(period, resolution, now);

  return buckets.map((bucket) => {
    const point = byKey.get(bucket);

    if (!point) {
      return {
        timestamp: bucket,
        avg: null,
        min: null,
        max: null,
        count: null,
        rangeBase: null,
        rangeSpan: null,
        missing: true,
      };
    }

    const min = Number(point.min);
    const max = Number(point.max);

    return {
      timestamp: bucket,
      avg: Number(point.avg),
      min,
      max,
      count: Number(point.count) || 0,
      unit: point.unit,
      rangeBase: min,
      rangeSpan: Number.isFinite(min) && Number.isFinite(max) ? max - min : null,
      missing: false,
    };
  });
}

export function expectedBuckets(period, resolution, now = Date.now()) {
  const end = startOfPacificBucket(new Date(now), resolution);
  const hours =
    period === "24h" ? 24 : period === "7d" ? 168 : period === "30d" ? 720 : 168;
  const count = resolution === "day" ? Math.ceil(hours / 24) : hours;
  const buckets = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const bucket = resolution === "day"
      ? startOfPacificBucket(new Date(end.getTime() - i * 86_400_000), "day")
      : new Date(end.getTime() - i * 3_600_000);
    buckets.push(bucketIso(bucket));
  }

  return buckets;
}

export function normalizeBucketKey(iso, resolution) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return bucketIso(startOfPacificBucket(date, resolution));
}

/**
 * Build sensor → measurement options from live readings.
 * Historical-only sensors are not discoverable without a metadata endpoint.
 */
export function discoveryFromLiveReadings(readings, sortTypes = (types) => [...types].sort()) {
  const bySensor = new Map();

  for (const reading of readings ?? []) {
    const sensorId = reading.sensor_id;
    const type = reading.measurement_type;

    if (!sensorId || !type) continue;

    if (!bySensor.has(sensorId)) {
      bySensor.set(sensorId, new Set());
    }

    bySensor.get(sensorId).add(type);
  }

  const sensors = [...bySensor.keys()].sort();
  const measurementsBySensor = {};

  for (const sensorId of sensors) {
    measurementsBySensor[sensorId] = sortTypes([...bySensor.get(sensorId)]);
  }

  return { sensors, measurementsBySensor };
}
