import { useMemo, useState } from "react";
import { discoveryFromLiveReadings } from "../../lib/historyStats.js";
import { sortMeasurementTypes } from "../../lib/metrics.js";
import { gatewaysFromReadings } from "../../lib/scoreStats.js";
import { useHistoricalSeries } from "../../hooks/useHistoricalSeries.js";
import { useScoreHistory } from "../../hooks/useScoreHistory.js";
import { ComingSoonPanel } from "../shared/ComingSoonPanel.jsx";
import { HistoryChart } from "./HistoryChart.jsx";
import { HistoryControls } from "./HistoryControls.jsx";
import { HistoryInsights } from "./HistoryInsights.jsx";
import { HistorySummary } from "./HistorySummary.jsx";
import { ScoreHistoryChart } from "./ScoreHistoryChart.jsx";
import { ScoreHistorySummary } from "./ScoreHistorySummary.jsx";
import { PERIOD_LABELS } from "../../lib/format.js";

/**
 * Sensor / measurement discovery uses the live latest endpoint.
 * Sensors that only exist in the warehouse (no current Redis key) will not
 * appear here until a dedicated history metadata endpoint exists.
 */
export function HistoryView({ readings, now, embedded = false }) {
  const discovery = useMemo(
    () => discoveryFromLiveReadings(readings, sortMeasurementTypes),
    [readings]
  );
  const gateways = useMemo(() => gatewaysFromReadings(readings), [readings]);

  const [mode, setMode] = useState("score");
  const [sensorId, setSensorId] = useState("");
  const [measurementType, setMeasurementType] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [period, setPeriod] = useState("7d");

  const resolvedSensorId =
    sensorId && discovery.sensors.includes(sensorId)
      ? sensorId
      : (discovery.sensors[0] ?? "");

  const measurements =
    discovery.measurementsBySensor[resolvedSensorId] ?? [];

  const resolvedMeasurementType =
    measurementType && measurements.includes(measurementType)
      ? measurementType
      : (measurements[0] ?? "");

  const resolvedGatewayId =
    gatewayId && gateways.includes(gatewayId)
      ? gatewayId
      : (gateways[0] ?? "");

  const sensorSeries = useHistoricalSeries({
    sensorId: resolvedSensorId,
    measurementType: resolvedMeasurementType,
    period,
    enabled:
      mode === "sensor" &&
      Boolean(resolvedSensorId && resolvedMeasurementType),
  });

  const scoreSeries = useScoreHistory({
    gatewayId: resolvedGatewayId,
    period,
    enabled: mode === "score" && Boolean(resolvedGatewayId),
  });

  const liveReading = useMemo(
    () =>
      readings.find(
        (reading) =>
          reading.sensor_id === resolvedSensorId &&
          reading.measurement_type === resolvedMeasurementType
      ) ?? null,
    [readings, resolvedSensorId, resolvedMeasurementType]
  );

  const unit =
    sensorSeries.series?.unit ??
    sensorSeries.summary.unit ??
    liveReading?.unit ??
    null;

  return (
    <section
      className={embedded ? "history-view history-view-embedded" : "view history-view"}
      aria-label="Environmental history"
    >
      {!embedded && (
        <div className="view-toolbar">
          <div>
            <h2 className="view-title">Historical analytics</h2>
            <p className="view-copy">
              Warehouse trends — environmental conditions score or individual
              sensor series. Hourly for 24h/7d, daily for 30d.
            </p>
          </div>
          <span className="pill pill-idle">
            <span className="pill-dot" />
            Warehouse
          </span>
        </div>
      )}

      {embedded && (
        <div className="section-block-head">
          <h3 className="section-heading">Environmental trends</h3>
          <p className="view-copy">
            Conditions score or individual sensor series. Hourly for 24h/7d,
            daily for 30d.
          </p>
        </div>
      )}

      <div className="history-mode" role="tablist" aria-label="History metric">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "score"}
          className={mode === "score" ? "tab is-active" : "tab"}
          onClick={() => setMode("score")}
        >
          Conditions score
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "sensor"}
          className={mode === "sensor" ? "tab is-active" : "tab"}
          onClick={() => setMode("sensor")}
        >
          Sensor readings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "automations"}
          className={mode === "automations" ? "tab is-active" : "tab"}
          onClick={() => setMode("automations")}
        >
          Automations
        </button>
      </div>

      {mode === "automations" ? (
        <ComingSoonPanel
          title="Automation analytics"
          description="Counts, timing, and outcome charts for fan and pump events need dbt marts on automation topics. Placeholder until those models ship."
        />
      ) : mode === "score" ? (
        <>
          <div className="history-controls history-controls-score">
            <label className="control">
              <span className="control-label">Gateway</span>
              <select
                value={resolvedGatewayId}
                onChange={(event) => setGatewayId(event.target.value)}
                disabled={gateways.length === 0}
              >
                {gateways.length === 0 && (
                  <option value="">No gateways found</option>
                )}
                {gateways.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <div className="control control-period">
              <span className="control-label" id="score-period-label">
                Period
              </span>
              <div
                className="segmented"
                role="radiogroup"
                aria-labelledby="score-period-label"
              >
                {["24h", "7d", "30d"].map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={period === value}
                    className={
                      period === value ? "segment is-active" : "segment"
                    }
                    onClick={() => setPeriod(value)}
                    disabled={gateways.length === 0}
                  >
                    {PERIOD_LABELS[value] ?? value}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {gateways.length === 0 && (
            <p className="notice notice-info" role="status">
              No live gateways available. Score history discovery uses the live
              endpoint.
            </p>
          )}

          {scoreSeries.error && (
            <p className="notice" role="alert">
              {scoreSeries.error}
            </p>
          )}

          {scoreSeries.status === "ok" && scoreSeries.summary.validCount > 0 && (
            <ScoreHistorySummary
              summary={scoreSeries.summary}
              period={period}
              resolution={scoreSeries.resolution}
              scoreVersion={scoreSeries.series?.score_version}
              now={now}
            />
          )}

          <ScoreHistoryChart
            data={scoreSeries.chartData}
            resolution={scoreSeries.resolution}
            period={period}
            scoreVersion={scoreSeries.series?.score_version}
            status={
              gateways.length === 0
                ? "error"
                : scoreSeries.status === "idle"
                  ? "loading"
                  : scoreSeries.status
            }
          />
        </>
      ) : (
        <>
          <HistoryControls
            sensors={discovery.sensors}
            measurements={measurements}
            sensorId={resolvedSensorId}
            measurementType={resolvedMeasurementType}
            period={period}
            onSensorChange={(next) => {
              setSensorId(next);
              setMeasurementType("");
            }}
            onMeasurementChange={setMeasurementType}
            onPeriodChange={setPeriod}
            disabled={discovery.sensors.length === 0}
          />

          {discovery.sensors.length === 0 && (
            <p className="notice notice-info" role="status">
              No live sensors are available to select from. History discovery
              uses the live endpoint, so warehouse-only sensors cannot be listed
              yet.
            </p>
          )}

          {sensorSeries.error && (
            <p className="notice" role="alert">
              {sensorSeries.error}
            </p>
          )}

          {sensorSeries.status === "ok" &&
            sensorSeries.summary.totalReadings > 0 && (
              <HistorySummary
                summary={sensorSeries.summary}
                period={period}
                resolution={sensorSeries.resolution}
                unit={unit}
                liveReading={liveReading}
                now={now}
              />
            )}

          <HistoryChart
            data={sensorSeries.chartData}
            resolution={sensorSeries.resolution}
            period={period}
            unit={unit}
            measurementType={resolvedMeasurementType}
            status={
              discovery.sensors.length === 0
                ? "error"
                : sensorSeries.status === "idle"
                  ? "loading"
                  : sensorSeries.status
            }
          />

          {sensorSeries.status === "ok" &&
            sensorSeries.summary.totalReadings > 0 && (
              <HistoryInsights
                insights={sensorSeries.insights}
                resolution={sensorSeries.resolution}
              />
            )}
        </>
      )}
    </section>
  );
}
