import {
  ENVIRONMENT_SCORE_CURRENT_URL,
  ENVIRONMENT_SCORE_HISTORY_URL,
} from "../api/config.js";

const ALLOWED_PERIODS = new Set(["24h", "7d", "30d"]);

export function buildCurrentScoreUrl(
  gatewayId,
  baseUrl = ENVIRONMENT_SCORE_CURRENT_URL
) {
  const url = new URL(baseUrl);
  url.searchParams.set("gateway_id", gatewayId);
  return url;
}

export function buildScoreHistoryUrl(
  { gatewayId, period },
  baseUrl = ENVIRONMENT_SCORE_HISTORY_URL
) {
  const url = new URL(baseUrl);
  url.searchParams.set("gateway_id", gatewayId);
  url.searchParams.set("period", period);
  return url;
}

export async function fetchCurrentScore(gatewayId, signal) {
  if (!gatewayId) {
    throw new Error("gateway_id is required");
  }

  const response = await fetch(buildCurrentScoreUrl(gatewayId), { signal });

  if (!response.ok) {
    let detail = `Score API error ${response.status}`;

    try {
      const body = await response.json();
      if (body?.detail) {
        detail =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail);
      }
    } catch {
      // keep status message
    }

    throw new Error(detail);
  }

  return response.json();
}

export async function fetchScoreHistory({ gatewayId, period }, signal) {
  if (!gatewayId) {
    throw new Error("gateway_id is required");
  }

  if (!ALLOWED_PERIODS.has(period)) {
    throw new Error(`Unsupported period: ${period}`);
  }

  const response = await fetch(
    buildScoreHistoryUrl({ gatewayId, period }),
    { signal }
  );

  if (!response.ok) {
    let detail = `Score history API error ${response.status}`;

    try {
      const body = await response.json();
      if (body?.detail) {
        detail =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail);
      }
    } catch {
      // keep status message
    }

    throw new Error(detail);
  }

  const data = await response.json();

  if (!data || typeof data !== "object" || !Array.isArray(data.points)) {
    throw new Error("Score history API returned an unexpected payload");
  }

  return data;
}
