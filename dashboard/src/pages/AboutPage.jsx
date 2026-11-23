export function AboutPage() {
  return (
    <section className="view about-view" aria-label="About">
      <div className="view-toolbar">
        <div>
          <h2 className="view-title">About</h2>
          <p className="view-copy">
            How this greenhouse pipeline is put together.
          </p>
        </div>
      </div>

      <div className="about-card">
        <h3>Greenhouse IoT streaming</h3>
        <p>
          Sensor telemetry flows from the greenhouse gateway through Kafka into
          a live Redis view and a Snowflake warehouse. This dashboard reads the
          FastAPI layer for live readings, environmental conditions scores, and
          historical series.
        </p>
        <ul className="about-list">
          <li>
            <strong>Live</strong> — Redis-backed latest readings and recent
            automation events.
          </li>
          <li>
            <strong>Score</strong> — Rules-based suitability from temperature,
            humidity, and calibrated soil moisture.
          </li>
          <li>
            <strong>History</strong> — Hourly and daily warehouse aggregates via
            dbt marts.
          </li>
        </ul>
        <p className="about-note">
          Control, AI analyst, and automation analytics panels are placeholders
          until those product surfaces are ready.
        </p>
      </div>
    </section>
  );
}
