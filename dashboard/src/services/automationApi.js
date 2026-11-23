import { AUTOMATION_EVENTS_RECENT_URL } from "../api/config.js";

export async function fetchRecentAutomationEvents(
  signal,
  baseUrl = AUTOMATION_EVENTS_RECENT_URL
) {
  const response = await fetch(baseUrl, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Automation events request failed (${response.status})`);
  }

  const body = await response.json();
  return Array.isArray(body?.events) ? body.events : [];
}
