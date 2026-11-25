# Dashboard

React and Vite single-page app for greenhouse monitoring. It is the last stage of the [Greenhouse Automation and Analytics](../README.md) project; data comes from the FastAPI service described in [Architecture](../docs/architecture.md) and [API reference](../docs/api.md).

Live site: <https://greenhouse.gregoryjoshua.com>

## Pages

A collapsible sidebar (state kept in `localStorage`) switches between four pages. There is no router; `App.jsx` holds the current page.

| Page | Contents | Data |
| --- | --- | --- |
| **Home** | Status pill and last-update age; **Environmental Conditions Score** card (gateway picker when several exist); one card per sensor and measurement; compact **Greenhouse Analyst** card (arrow and suggested questions open the analyst on Analytics); **Recent automations** panel (latest fan and pump cycles, with a shortcut to automation analytics) | `GET /api/v1/sensors/latest` every 3 s, `GET /api/v1/environment/score/current`, `GET /api/v1/automation/events/recent` every 5 s |
| **Control** | Placeholder. Manual overrides are not wired up; the Pi's local automation runs independently | None |
| **Analytics** | **Greenhouse Analyst** workspace, then three history modes: **Conditions score**, **Sensor readings**, **Automations**. Periods `24h`, `7d`, `30d` (hourly or daily resolution from the API) | `POST /api/analyst/query` on submit; `GET /api/v1/environment/score/history`, `/api/v1/history/series`, `/api/v1/history/automations` |
| **About** | Short project description and a link to the repository | None |

### Behavior notes

- **Score.** The dashboard displays the score computed by the API; it never recomputes it. Null scores show as unavailable, never zero. Score failures do not hide sensor cards. Target bands shown beside each component are display-only constants in [`src/lib/scoreDisplay.js`](src/lib/scoreDisplay.js) and must match `config/environmental_score.v1.json` (`conditions-v2`).
- **Soil moisture.** Cards show the calibrated percentage and a `Wet-like` / `Dry-like` state from `calibrated_pct` and `state`; the raw value is kept as `raw_value`. Other `percent` readings also get a 0 to 100 bar.
- **Staleness.** A reading is stale when its event timestamp is more than 30 seconds old (`STALE_AFTER_MS` in [`src/lib/format.js`](src/lib/format.js)).
- **Units and time.** Temperatures display in °F; chart and event times use Pacific time (`America/Los_Angeles`).
- **Automations.** Home groups raw events into cycles (ON to OFF, by `cycle_id` where present) in [`src/lib/automationCycles.js`](src/lib/automationCycles.js). The Automations analytics mode draws the actuator's sensor series (calibrated soil moisture for the pump, air temperature for the fan) with cycle markers from the warehouse.
- **AI analyst.** One question at a time; each submission replaces the previous analysis (the backend has no conversation memory). The card grows downward in normal page flow: the answer, then a chart, then key observations and notes, then the MetricFlow provenance with **Show SQL** and **Query details**. The chart is built from the response's `visualization` (line, bar, table, single-value tiles, or none) with no metric-specific code; helpers live in [`src/lib/analystViz.js`](src/lib/analystViz.js). Warehouse times without an offset are shown as UTC. Opening the analyst from Home passes a one-time intent through `App.jsx` state that scrolls to and focuses the input (and runs the question, for a suggested-question click); opening Analytics from the sidebar does not autofocus. Recharts is loaded lazily with the first chart.
- **Discovery.** Gateways and sensors for pickers come from the live endpoint, so warehouse-only devices do not appear until a metadata endpoint exists.
- **Unknown measurement types** fall back to a generic label ([`src/lib/metrics.js`](src/lib/metrics.js)).

## Configuration

API origin comes from [`src/api/config.js`](src/api/config.js), which also defines every endpoint URL:

- Build-time override: `VITE_API_URL` or `VITE_API_BASE_URL`.
- Default: `https://api.gregoryjoshua.com`.

## Layout

```text
src/
├── api/config.js         API origin and endpoint URLs (including the analyst)
├── pages/                HomePage, ControlPage, AnalyticsPage, AboutPage
├── components/
│   ├── layout/           Sidebar, NavIcons
│   ├── live/             ScoreCard, ReadingCard
│   ├── automation/       RecentAutomations
│   ├── history/          HistoryView (score, sensor, automation modes), charts, summaries
│   ├── ai/               AiAnalystPanel (home card + workspace), AnalystComposer,
│   │                     AnalystResult, AnalystChart, AnalystSql
│   └── shared/           ComingSoonPanel
├── hooks/                useLiveReadings, useEnvironmentalScore, useAutomationEvents,
│                         useScoreHistory, useHistoricalSeries, useAutomationHistory,
│                         useAutomationCycleBackfill, useAnalystQuery
├── lib/                  metrics, format, scoreDisplay, scoreStats, historyStats,
│                         automationCycles, automationDisplay, analystViz (+ node:test tests)
├── services/             liveApi, environmentApi, automationApi, historyApi, automationHistoryApi,
│                         analystApi
└── App.jsx               Page state and sidebar
```

## Commands

```bash
npm ci
npm run dev       # Vite dev server on port 5173
npm run lint      # oxlint
npm run test      # node --test 'src/lib/*.test.js'
npm run build
npm run preview
```

## Related docs

- [Environmental Conditions Score](../docs/environmental-conditions-score.md)
- [API reference](../docs/api.md)
- [Snowflake setup](../docs/snowflake-setup.md)

## CI and deployment

The `dashboard` job runs `npm ci`, `npm run lint`, `npm run test`, and `npm run build`. Netlify publishes from Git; see [Deployment](../docs/deployment.md#dashboard-netlify).
