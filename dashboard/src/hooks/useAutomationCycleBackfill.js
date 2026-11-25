import { useEffect, useMemo, useState } from "react";
import {
  consolidateAutomationCycles,
  MIN_DISPLAYED_AUTOMATION_CYCLES,
} from "../lib/automationCycles.js";
import { fetchAutomationHistory } from "../services/automationHistoryApi.js";

const ACTUATORS = ["pump", "fan"];
const PERIOD = "30d";
const REFRESH_MS = 60_000;

/**
 * The live feed only retains a few raw events, which often collapse to fewer
 * than five cycles. Pull warehouse cycles so the home panel can show the last five.
 */
export function useAutomationCycleBackfill({
  gatewayId,
  events,
  enabled = true,
}) {
  const [cycles, setCycles] = useState([]);
  const [status, setStatus] = useState("idle");
  const [trackedGateway, setTrackedGateway] = useState(gatewayId);

  if (trackedGateway !== gatewayId) {
    setTrackedGateway(gatewayId);
    setCycles([]);
    setStatus("idle");
  }

  const liveCount = useMemo(
    () =>
      consolidateAutomationCycles(events, {
        limit: MIN_DISPLAYED_AUTOMATION_CYCLES,
      }).length,
    [events]
  );
  const needsBackfill =
    enabled && Boolean(gatewayId) && liveCount < MIN_DISPLAYED_AUTOMATION_CYCLES;

  useEffect(() => {
    if (!needsBackfill) return undefined;

    const controller = new AbortController();
    let cancelled = false;
    const requestedGateway = gatewayId;

    const load = async () => {
      const results = await Promise.allSettled(
        ACTUATORS.map((actuator) =>
          fetchAutomationHistory(
            { gatewayId: requestedGateway, actuator, period: PERIOD },
            controller.signal
          )
        )
      );

      if (cancelled || controller.signal.aborted) return;

      const next = [];
      let anyOk = false;
      let anyError = false;

      for (const result of results) {
        if (result.status === "fulfilled") {
          anyOk = true;
          if (Array.isArray(result.value?.cycles)) {
            next.push(...result.value.cycles);
          }
          continue;
        }
        if (result.reason?.name !== "AbortError") anyError = true;
      }

      if (anyOk) {
        setCycles(next);
        setStatus("ok");
        return;
      }

      if (anyError) setStatus("error");
    };

    load();
    const id = window.setInterval(load, REFRESH_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [needsBackfill, gatewayId]);

  const historyStatus = needsBackfill
    ? status === "idle"
      ? "loading"
      : status
    : "idle";

  return { historyCycles: cycles, historyStatus };
}
