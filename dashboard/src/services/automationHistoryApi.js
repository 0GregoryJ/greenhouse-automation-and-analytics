import { HISTORY_AUTOMATIONS_URL } from "../api/config.js";

const ALLOWED_PERIODS = new Set(["24h", "7d", "30d"]);
const ALLOWED_ACTUATORS = new Set(["pump", "fan"]);

/**
 * Fetch sensor series + actuator cycle markers for automation analytics.
 */
export async function fetchAutomationHistory(
  { gatewayId, actuator, period },
  signal
) {
  if (!gatewayId) {
    throw new Error("gateway_id is required");
  }

  if (!ALLOWED_ACTUATORS.has(actuator)) {
    throw new Error(`Unsupported actuator: ${actuator}`);
  }

  if (!ALLOWED_PERIODS.has(period)) {
    throw new Error(`Unsupported period: ${period}`);
  }

  const url = new URL(HISTORY_AUTOMATIONS_URL);
  url.searchParams.set("gateway_id", gatewayId);
  url.searchParams.set("actuator", actuator);
  url.searchParams.set("period", period);

  const response = await fetch(url, { signal });

  if (!response.ok) {
    let detail = `Automation history API error ${response.status}`;

    try {
      const body = await response.json();
      if (body?.detail) {
        detail =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail);
      }
    } catch {
      // keep status-based message
    }

    throw new Error(detail);
  }

  const data = await response.json();

  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray(data.points) ||
    !Array.isArray(data.cycles)
  ) {
    throw new Error("Automation history API returned an unexpected payload");
  }

  return data;
}
