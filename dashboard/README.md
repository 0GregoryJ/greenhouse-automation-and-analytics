# Dashboard

React and Vite single-page app for greenhouse monitoring. It is the last stage of the [Greenhouse IoT Streaming Pipeline](../README.md); data comes from the FastAPI service described in [Architecture](../docs/architecture.md) and [API reference](../docs/api.md).

Live site: <https://greenhouse.gregoryjoshua.com>

## Behavior

Two tabs share the same design language:

### Live

- Polls `GET /api/v1/sensors/latest` every 3 seconds (`useLiveReadings`).
- Shows a prominent **Environmental Conditions Score** card from `GET /api/v1/environment/score/current` (gateway discovered from live readings). Null scores render as unavailable — never as zero. Score API failures do not hide sensor cards.
- Renders one card per sensor and measurement type, labeled and ordered by the `METRICS` map in [`src/lib/metrics.js`](src/lib/metrics.js). Unknown measurement types fall back to a generic label.
- Marks a reading stale when its event timestamp is more than 30 seconds old (`STALE_AFTER_MS` in [`src/lib/format.js`](src/lib/format.js)).
- Displays temperatures in °F and chart/score timestamps in Pacific time (`America/Los_Angeles`).
- Formats other values by unit (`percent`, `hpa`, `raw_capacitance`); a `percent` reading also shows a 0 to 100 bar.

### History

- Mode toggle: **Conditions score** or **Sensor reading**.
- Score mode calls `GET /api/v1/environment/score/history` (0–100 axis, gaps for null, daily min–max band on 30d, summaries weighted by `scored_hours` for daily data).
- Sensor mode calls `GET /api/v1/history/series` with discovery from the live payload.
- Periods: `24h`, `7d`, `30d` (hourly vs daily resolution from the API).

## Configuration

API origin comes from [`src/api/config.js`](src/api/config.js):

- Build-time override: `VITE_API_URL` or `VITE_API_BASE_URL`.
- Default: `https://api.gregoryjoshua.com`.

## Layout

```text
src/
├── api/config.js
├── components/
│   ├── live/          LiveView, ScoreCard, ReadingCard
│   └── history/       HistoryView, score + sensor charts/summaries
├── hooks/             useLiveReadings, useEnvironmentalScore, useScoreHistory, …
├── lib/               metrics, format, historyStats, scoreStats (+ tests)
├── services/          liveApi, historyApi, environmentApi
└── App.jsx            Live | History tabs
```

## Commands

```bash
npm ci
npm run dev
npm run lint
npm run test
npm run build
npm run preview
```

## Related docs

- [Environmental Conditions Score](../docs/environmental-conditions-score.md)
- [API reference](../docs/api.md)
- [Snowflake setup](../docs/snowflake-setup.md)

## CI and deployment

The `dashboard` job runs `npm ci`, `npm run lint`, `npm run test`, and `npm run build`. Netlify publishes from Git; see [Deployment](../docs/deployment.md#dashboard-netlify).
