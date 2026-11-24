import { useEffect, useMemo, useRef, useState } from "react";
import { AiAnalystPanel } from "../components/ai/AiAnalystPanel.jsx";
import { RecentAutomations } from "../components/automation/RecentAutomations.jsx";
import { ReadingCard, SkeletonCards } from "../components/live/ReadingCard.jsx";
import { ScoreCard } from "../components/live/ScoreCard.jsx";
import { useAutomationEvents } from "../hooks/useAutomationEvents.js";
import { useEnvironmentalScore } from "../hooks/useEnvironmentalScore.js";
import { formatAge } from "../lib/format.js";
import { metricInfo } from "../lib/metrics.js";
import { gatewaysFromReadings } from "../lib/scoreStats.js";

function getStatus({ loaded, error, readings, now }) {
  if (error && readings.length === 0) return { key: "offline", label: "Offline" };
  if (!loaded) return { key: "connecting", label: "Connecting" };
  if (readings.length === 0) return { key: "empty", label: "No data" };

  const anyFresh = readings.some((reading) => {
    const eventTime = new Date(reading.timestamp).getTime();
    return Number.isFinite(eventTime) && now - eventTime <= 30_000;
  });

  return anyFresh
    ? { key: "live", label: "Live" }
    : { key: "stale", label: "Stale" };
}

export function HomePage({
  readings,
  status: loadStatus,
  error,
  lastFetchedAt,
  now,
  onOpenAutomationAnalytics,
}) {
  const loaded = loadStatus !== "loading" || readings.length > 0;
  const sorted = [...readings].sort(
    (a, b) =>
      metricInfo(a.measurement_type).order -
        metricInfo(b.measurement_type).order ||
      String(a.sensor_id).localeCompare(String(b.sensor_id))
  );
  const liveStatus = getStatus({ loaded, error, readings, now });

  const gateways = useMemo(() => gatewaysFromReadings(readings), [readings]);
  const [gatewayId, setGatewayId] = useState("");
  const resolvedGatewayId =
    gatewayId && gateways.includes(gatewayId)
      ? gatewayId
      : (gateways[0] ?? "");

  const {
    score,
    status: scoreStatus,
    error: scoreError,
  } = useEnvironmentalScore({
    gatewayId: resolvedGatewayId,
    enabled: Boolean(resolvedGatewayId),
  });

  const {
    events,
    status: automationStatus,
    error: automationError,
  } = useAutomationEvents({ enabled: true });

  const aiPanelRef = useRef(null);
  const [automationsHeight, setAutomationsHeight] = useState(null);

  useEffect(() => {
    const node = aiPanelRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;

    const syncHeight = () => {
      setAutomationsHeight(Math.round(node.getBoundingClientRect().height));
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="view home-view" aria-label="Home">
      <div className="view-toolbar view-toolbar-status-only">
        <div className="top-status top-status-inline">
          <span className={`pill pill-${liveStatus.key}`}>
            <span className="pill-dot" />
            {liveStatus.label}
          </span>
          {lastFetchedAt && (
            <span className="updated">
              Last update {formatAge(now - lastFetchedAt)}
            </span>
          )}
        </div>
      </div>

      {error && (
        <p className="notice" role="alert">
          {readings.length > 0
            ? "Can't reach the API. Showing the last known readings."
            : "Can't reach the API."}
        </p>
      )}

      {resolvedGatewayId && (
        <ScoreCard
          scorePayload={score}
          status={scoreStatus}
          error={scoreError}
          gatewayId={resolvedGatewayId}
          gateways={gateways}
          onGatewayChange={setGatewayId}
        />
      )}

      <div className="grid">
        {!loaded && !error && <SkeletonCards />}
        {sorted.map((reading) => (
          <ReadingCard
            key={`${reading.gateway_id}-${reading.sensor_id}-${reading.measurement_type}`}
            reading={reading}
            now={now}
          />
        ))}
      </div>

      {loaded && !error && readings.length === 0 && (
        <p className="empty">No readings available yet.</p>
      )}

      <div className="home-secondary">
        <div className="home-ai-slot" ref={aiPanelRef}>
          <AiAnalystPanel />
        </div>
        <RecentAutomations
          events={events}
          status={automationStatus}
          error={automationError}
          now={now}
          onOpenAnalytics={onOpenAutomationAnalytics}
          style={
            automationsHeight
              ? { height: `${automationsHeight}px` }
              : undefined
          }
        />
      </div>
    </section>
  );
}
