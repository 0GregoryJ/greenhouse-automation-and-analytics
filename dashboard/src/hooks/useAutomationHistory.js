import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAutomationHistory } from "../services/automationHistoryApi.js";
import { fillTimeline, summarizePoints } from "../lib/historyStats.js";

export function useAutomationHistory({
  gatewayId,
  actuator,
  period,
  enabled = true,
}) {
  const requestKey =
    enabled && gatewayId && actuator && period
      ? `${gatewayId}|${actuator}|${period}`
      : null;

  const [series, setSeries] = useState(null);
  const [fetchStatus, setFetchStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [activeKey, setActiveKey] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!requestKey) return undefined;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const [nextGatewayId, nextActuator, nextPeriod] = requestKey.split("|");

    setFetchStatus("loading");
    setError(null);
    setActiveKey(requestKey);

    fetchAutomationHistory(
      {
        gatewayId: nextGatewayId,
        actuator: nextActuator,
        period: nextPeriod,
      },
      controller.signal
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setSeries(data);
        setFetchStatus("ok");
        setActiveKey(requestKey);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setSeries(null);
        setFetchStatus("error");
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load automation history"
        );
        setActiveKey(requestKey);
      });

    return () => controller.abort();
  }, [requestKey]);

  const status = !requestKey
    ? "idle"
    : activeKey === requestKey
      ? fetchStatus
      : "loading";

  const points = activeKey === requestKey ? series?.points : undefined;
  const cycles = activeKey === requestKey ? series?.cycles : undefined;
  const resolution =
    (activeKey === requestKey ? series?.resolution : null) ??
    (period === "30d" ? "day" : "hour");

  const summary = useMemo(() => summarizePoints(points ?? []), [points]);
  const chartData = useMemo(
    () => fillTimeline(points ?? [], period, resolution),
    [points, period, resolution]
  );

  return {
    series: activeKey === requestKey ? series : null,
    points: points ?? [],
    cycles: cycles ?? [],
    resolution,
    summary,
    chartData,
    status,
    error: activeKey === requestKey ? error : null,
  };
}
