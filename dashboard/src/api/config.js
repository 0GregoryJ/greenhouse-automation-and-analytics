/**
 * Shared API origin for live and history endpoints.
 * Override at build time with VITE_API_URL or VITE_API_BASE_URL
 * (origin only, no trailing slash; paths are appended below).
 */
function resolveApiBaseUrl() {
  const env =
    typeof import.meta !== "undefined" && import.meta.env
      ? import.meta.env
      : {};
  const configured =
    env.VITE_API_URL ||
    env.VITE_API_BASE_URL ||
    "https://api.gregoryjoshua.com";

  const trimmed = String(configured).replace(/\/$/, "");

  // Allow either an origin or a full .../api/v1 base.
  return trimmed.replace(/\/api\/v1$/, "");
}

export const API_BASE_URL = resolveApiBaseUrl();

export const LIVE_LATEST_URL = `${API_BASE_URL}/api/v1/sensors/latest`;
export const HISTORY_SERIES_URL = `${API_BASE_URL}/api/v1/history/series`;
export const ENVIRONMENT_SCORE_CURRENT_URL = `${API_BASE_URL}/api/v1/environment/score/current`;
export const ENVIRONMENT_SCORE_HISTORY_URL = `${API_BASE_URL}/api/v1/environment/score/history`;
