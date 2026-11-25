import { ANALYST_QUERY_URL } from "../api/config.js";

function detailMessage(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && typeof detail[0]?.msg === "string") {
    return detail[0].msg;
  }
  return null;
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

export function normalizeAnalystResponse(data) {
  if (!data || typeof data !== "object" || typeof data.answer !== "string") {
    throw new Error("The analyst returned an unexpected response.");
  }

  const viz =
    data.visualization && typeof data.visualization === "object"
      ? data.visualization
      : null;

  return {
    question: typeof data.question === "string" ? data.question : "",
    answer: data.answer,
    highlights: stringList(data.highlights),
    caveats: stringList(data.caveats),
    query: data.query && typeof data.query === "object" ? data.query : null,
    visualization: viz && {
      type: viz.type ?? "none",
      title: typeof viz.title === "string" ? viz.title : "",
      xKey: viz.xKey ?? null,
      series: Array.isArray(viz.series) ? viz.series : [],
      columns: Array.isArray(viz.columns) ? viz.columns : [],
      rows: Array.isArray(viz.rows) ? viz.rows : [],
    },
    sql: typeof data.sql === "string" && data.sql.trim() ? data.sql : null,
    sqlError: typeof data.sql_error === "string" ? data.sql_error : null,
    source: typeof data.source === "string" ? data.source : null,
  };
}

export async function fetchAnalystAnswer(question, signal) {
  let response;
  try {
    response = await fetch(ANALYST_QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ question }),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Can't reach the analyst service. Check your connection and try again.");
  }

  if (!response.ok) {
    let detail = null;
    try {
      const body = await response.json();
      detail = detailMessage(body?.detail);
    } catch {
      // keep status message
    }

    if (detail && response.status < 500) throw new Error(detail);
    throw new Error(
      response.status >= 500
        ? "The analyst service is temporarily unavailable. Try again shortly."
        : `Analyst request failed (${response.status}).`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The analyst returned an unreadable response.");
  }

  return normalizeAnalystResponse(data);
}
