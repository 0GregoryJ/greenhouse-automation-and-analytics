import { formatValueText } from "./format.js";
import { COMPONENT_LABELS } from "./scoreStats.js";

/**
 * Display-only target bands for conditions-v1.
 * Keep in sync with config/environmental_score.v1.json — changing targets
 * should bump score_version. React does not recompute the composite score.
 */
export const SCORE_TARGET_BANDS = {
  air_temperature: {
    unit: "celsius",
    targetMin: 20,
    targetMax: 26,
    belowLabel: "too cold",
    inRangeLabel: "in range",
    aboveLabel: "too warm",
  },
  relative_humidity: {
    unit: "percent",
    targetMin: 50,
    targetMax: 70,
    belowLabel: "too dry",
    inRangeLabel: "in range",
    aboveLabel: "too humid",
  },
  soil_moisture: {
    unit: "raw_capacitance",
    targetMin: 450,
    targetMax: 800,
    belowLabel: "too dry",
    inRangeLabel: "in range",
    aboveLabel: "too wet",
  },
};

export function bandForReading(metric, reading) {
  const band = SCORE_TARGET_BANDS[metric];

  if (!band || reading === null || reading === undefined) {
    return { bandKey: "unknown", bandLabel: "unknown" };
  }

  const value = Number(reading);

  if (!Number.isFinite(value)) {
    return { bandKey: "unknown", bandLabel: "unknown" };
  }

  if (value < band.targetMin) {
    return { bandKey: "below", bandLabel: band.belowLabel };
  }

  if (value > band.targetMax) {
    return { bandKey: "above", bandLabel: band.aboveLabel };
  }

  return { bandKey: "in_range", bandLabel: band.inRangeLabel };
}

export function formatSuitability(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return "—/100";
  }

  return `${Math.round(Number(score))}/100`;
}

/**
 * Describe one score factor for the live breakdown UI.
 */
export function describeComponent({ metric, reading, score }) {
  const band = SCORE_TARGET_BANDS[metric];
  const { bandKey, bandLabel } = bandForReading(metric, reading);
  const readingLabel = band
    ? formatValueText({ value: reading, unit: band.unit })
    : "—";

  return {
    metric,
    label: COMPONENT_LABELS[metric] ?? metric,
    readingLabel,
    bandKey,
    bandLabel,
    suitability: Number.isFinite(Number(score)) ? Number(score) : null,
    suitabilityLabel: formatSuitability(score),
  };
}

export function limitedByLabel(lowest) {
  if (!lowest?.name) return null;

  const label = COMPONENT_LABELS[lowest.name] ?? lowest.name;
  return `Mostly limited by ${label.toLowerCase()}.`;
}

/** Only when one factor is uniquely lowest (explains a pulled-down composite). */
export function limitingFactor(components) {
  const entries = Object.entries(components ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => ({ name, score: Number(value) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score);

  if (entries.length < 2) return null;

  const [lowest, next] = entries;

  if (lowest.score >= next.score) return null;

  return limitedByLabel(lowest);
}
