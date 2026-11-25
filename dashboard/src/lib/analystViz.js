/**
 * Pure helpers that turn the analyst API `visualization` payload into
 * chart-ready data. Nothing here knows about specific metrics.
 */

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const GRANULARITIES = ["hour", "day", "week", "month", "quarter", "year"];

const UNIT_SUFFIXES = [
  { token: "pct", unit: "%" },
  { token: "c", unit: "°C" },
  { token: "seconds", unit: "s" },
  { token: "hours", unit: "h" },
];

const WORD_OVERRIDES = { avg: "Avg", min: "Min", max: "Max", utc: "UTC", id: "ID" };

function tokensFor(key) {
  const name = String(key ?? "").toLowerCase();
  const local = name.includes("__") ? name.split("__").pop() : name;
  return local.split("_").filter(Boolean);
}

/** Display unit inferred from a metric name suffix/prefix, e.g. `_pct` -> `%`. */
export function unitForKey(key) {
  const tokens = tokensFor(key);
  if (tokens[0] === "pct") return "%";
  const last = tokens[tokens.length - 1];
  return UNIT_SUFFIXES.find((entry) => entry.token === last)?.unit ?? null;
}

/** `AVG_SOIL_MOISTURE_PCT` -> "Avg soil moisture (%)"; `metric_time__day` -> "Day". */
export function humanizeKey(key) {
  let tokens = tokensFor(key);
  if (tokens.length === 0) return String(key ?? "");

  const unit = unitForKey(key);
  if (unit) {
    tokens = tokens[0] === "pct" ? tokens.slice(1) : tokens.slice(0, -1);
  }

  const words = tokens.map((token, index) => {
    if (WORD_OVERRIDES[token]) return WORD_OVERRIDES[token];
    return index === 0 ? token.charAt(0).toUpperCase() + token.slice(1) : token;
  });

  const label = words.join(" ");
  return unit ? `${label} (${unit})` : label;
}

export function granularityForKey(key) {
  const last = String(key ?? "").toLowerCase().split("__").pop();
  return GRANULARITIES.includes(last) ? last : null;
}

/**
 * Parses warehouse timestamps. Values without an offset are treated as UTC,
 * matching how MetricFlow returns `metric_time` and `*_utc` dimensions.
 */
export function parseTimeValue(value) {
  if (typeof value !== "string" || !DATE_PREFIX.test(value)) return null;
  const trimmed = value.trim();
  const iso = trimmed.length === 10 ? `${trimmed}T00:00:00` : trimmed.replace(" ", "T");
  const ms = Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function isTimeColumn(rows, key) {
  if (!key) return false;
  let seen = 0;
  for (const row of rows) {
    const value = row?.[key];
    if (value === null || value === undefined) continue;
    if (parseTimeValue(value) === null) return false;
    seen += 1;
  }
  return seen > 0;
}

/** Numbers stay numbers, numeric strings become numbers, everything else is null. */
export function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function inferGranularity(rows, xKey) {
  const times = rows
    .map((row) => parseTimeValue(row?.[xKey]))
    .filter((ms) => ms !== null);
  const allMidnight = times.every((ms) => ms % 86_400_000 === 0);
  return allMidnight ? "day" : "hour";
}

/**
 * Normalizes the API visualization into `{ mode, rows, series, ... }`.
 * mode: "line" | "bar" | "table" | "kpi" | "none"
 */
export function prepareVisualization(viz) {
  const rawRows = Array.isArray(viz?.rows) ? viz.rows : [];
  const columns =
    Array.isArray(viz?.columns) && viz.columns.length > 0
      ? viz.columns.map(String)
      : Object.keys(rawRows[0] ?? {});
  const xKey = viz?.xKey && columns.includes(viz.xKey) ? viz.xKey : null;

  const series = (Array.isArray(viz?.series) ? viz.series : [])
    .filter((item) => item && columns.includes(item.dataKey))
    .map((item) => ({
      dataKey: item.dataKey,
      label: humanizeKey(item.label || item.dataKey),
      unit: unitForKey(item.label || item.dataKey),
    }));

  const base = {
    title: typeof viz?.title === "string" ? viz.title : "",
    columns,
    xKey,
    series,
    isTime: false,
    granularity: null,
  };

  if (viz?.type === "none" || rawRows.length === 0) {
    return { ...base, mode: "none", rows: [] };
  }

  const numericKeys = new Set(series.map((item) => item.dataKey));
  let rows = rawRows.map((row) => {
    const next = { ...row };
    for (const key of numericKeys) next[key] = toNumberOrNull(row?.[key]);
    return next;
  });

  const isTime = isTimeColumn(rows, xKey);
  if (isTime) {
    rows = [...rows].sort((a, b) => {
      const ta = parseTimeValue(a[xKey]);
      const tb = parseTimeValue(b[xKey]);
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    });
  }

  const granularity = isTime
    ? (granularityForKey(xKey) ?? inferGranularity(rows, xKey))
    : null;

  let mode = viz?.type;
  const chartable = xKey && series.length > 0;
  if ((mode === "line" || mode === "bar") && !chartable) mode = "table";
  if (mode !== "line" && mode !== "bar") mode = "table";
  if (mode === "table" && rows.length === 1 && !xKey && series.length > 0 && series.length <= 4) {
    mode = "kpi";
  }

  return { ...base, mode, rows, isTime, granularity };
}

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatAnalystNumber(value, unit = null) {
  const n = toNumberOrNull(value);
  if (n === null) return "—";
  const text = numberFormatter.format(n);
  if (!unit) return text;
  return unit === "%" || unit === "°C" ? `${text}${unit}` : `${text} ${unit}`;
}

export function formatAxisNumber(value) {
  const n = toNumberOrNull(value);
  if (n === null) return "";
  return Math.abs(n) >= 10_000 ? compactFormatter.format(n) : numberFormatter.format(n);
}

/** Short axis label for a time value at the given granularity (UTC wall clock). */
export function formatTimeTick(value, granularity) {
  const ms = parseTimeValue(value);
  if (ms === null) return String(value ?? "");
  const date = new Date(ms);
  const opts = { timeZone: "UTC" };
  if (granularity === "hour") {
    Object.assign(opts, { month: "short", day: "numeric", hour: "numeric" });
  } else if (granularity === "month" || granularity === "quarter") {
    Object.assign(opts, { month: "short", year: "numeric" });
  } else if (granularity === "year") {
    opts.year = "numeric";
  } else {
    Object.assign(opts, { month: "short", day: "numeric" });
  }
  return date.toLocaleString("en-US", opts);
}

/** Longer label for tooltips and tables. */
export function formatTimeLabel(value, granularity) {
  const ms = parseTimeValue(value);
  if (ms === null) return String(value ?? "");
  const date = new Date(ms);
  const opts = { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" };
  if (granularity === "hour" || granularity === null) {
    Object.assign(opts, { hour: "numeric", minute: "2-digit" });
    return `${date.toLocaleString("en-US", opts)} UTC`;
  }
  if (granularity === "week") return `Week of ${date.toLocaleString("en-US", opts)}`;
  return date.toLocaleString("en-US", opts);
}

export function formatCell(value, { isTime = false, granularity = null, unit = null, numeric = false } = {}) {
  if (value === null || value === undefined || value === "") return "—";
  if (isTime) return formatTimeLabel(value, granularity);
  if (numeric || typeof value === "number") return formatAnalystNumber(value, unit);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
