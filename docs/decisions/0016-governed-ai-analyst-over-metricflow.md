# ADR 0016: Governed AI analyst over a MetricFlow semantic layer

**Status:** Accepted
**Recorded:** 2026-11-25

## Context

The dashboard should answer plain-English questions about greenhouse data ("how has soil moisture changed this week?", "how many times did the pump run?"). Letting an LLM write SQL against Snowflake would be fast to build but hard to trust: the model can pick the wrong table, average an average, misread the calibrated-moisture caveats, or invent columns, and the warehouse would execute whatever it produced. The dbt project already defines a MetricFlow semantic layer with reviewed metric definitions, units, and limitations ([Semantic layer](../../warehouse/docs/semantic_layer.md)).

## Decision

- **The model plans; it never writes SQL.** OpenAI returns a strict structured plan (`QueryPlan`: metrics, group_by, start and end dates, limit, chart type, or `answerable: false`). The plan is parsed with a Pydantic schema, not free text.
- **Validate against an approved catalog.** Every metric and dimension must appear in [`api/analyst_catalog.json`](../../api/analyst_catalog.json), every dimension must be compatible with every chosen metric, at most 3 metrics and 2 dimensions, a window of at most 366 days, no future dates, and at most 100 rows. Anything else is refused with a readable reason.
- **MetricFlow executes and compiles.** The approved query runs through the API's own `POST /api/metrics/query`, which re-validates names against MetricFlow's live catalog and runs `mf query` without a shell. `mf query --explain` compiles the same query so the UI can show the actual SQL.
- **Summaries are grounded in returned rows.** A second model call sees only the plan and up to 100 rows, is told not to invent causes or statistics and to distinguish missing data from zero, and returns `answer`, `highlights`, and `caveats`. With no rows, a fixed answer is returned without a model call.
- **Chart-ready response.** The API returns a `visualization` object (type, x key, series, columns, sorted rows) so the dashboard renders charts generically, with no metric-specific frontend code.
- **Single-question, stateless.** Each request is independent; there is no conversation memory yet.
- **Same service, server-side key.** The analyst runs inside the existing FastAPI container. The OpenAI key lives only in the serving host's `.env`.

## Consequences

- Answers are limited to what the semantic layer can express. Causal questions ("does irrigation raise moisture?") are refused until an automation-impact model exists, which is intentional.
- Numbers are traceable: the dashboard separates the AI-written explanation from the governed query result and shows the MetricFlow SQL on request.
- The catalog is maintained by hand and can drift from the semantic manifest; new metrics need an entry before the analyst will use them.
- The API image now carries dbt, MetricFlow, and the dbt project, and needs a dbt profile mounted from the host. Semantic-layer changes require an API rebuild.
- Each question costs two OpenAI calls and one or two MetricFlow runs on Snowflake, and takes seconds to tens of seconds. The analyst and metrics endpoints have no authentication or rate limiting yet, so cost is exposed to anyone who can reach the API.
- The current query path passes `--end-time`, which this MetricFlow version treats as a date and so excludes the last day of a range; see the semantic layer notes.

## Related

[API reference: AI analyst](../api.md#ai-analyst), [Semantic layer](../../warehouse/docs/semantic_layer.md), [`api/services/analyst.py`](../../api/services/analyst.py), [`api/services/metricflow.py`](../../api/services/metricflow.py), [Dashboard](../../dashboard/README.md), [ADR 0011](0011-dashboard-polls-a-read-only-api.md), [ADR 0013](0013-snowflake-history-api-with-jwt-key.md)
