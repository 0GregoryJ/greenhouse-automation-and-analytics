import { useEffect, useMemo, useRef, useState } from "react";
import { fetchScoreHistory } from "../services/environmentApi.js";
import {
  fillScoreTimeline,
  summarizeScoreSeries,
} from "../lib/scoreStats.js";

export function useScoreHistory({
  gatewayId,
  period,
  enabled = true,
}) {
  const requestKey =
    enabled && gatewayId && period
      ? `${gatewayId}|${period}`
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

    const [nextGatewayId, nextPeriod] = requestKey.split("|");

    setFetchStatus("loading");
    setError(null);
    setActiveKey(requestKey);

    fetchScoreHistory(
      { gatewayId: nextGatewayId, period: nextPeriod },
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
          err instanceof Error ? err.message : "Failed to load score history"
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
  const resolution =
    (activeKey === requestKey ? series?.resolution : null) ??
    (period === "30d" ? "day" : "hour");

  const summary = useMemo(
    () => summarizeScoreSeries(points ?? [], resolution),
    [points, resolution]
  );

  const chartData = useMemo(
    () => fillScoreTimeline(points ?? [], period, resolution),
    [points, period, resolution]
  );

  return {
    series: activeKey === requestKey ? series : null,
    points: points ?? [],
    resolution,
    summary,
    chartData,
    status,
    error: activeKey === requestKey ? error : null,
  };
}
