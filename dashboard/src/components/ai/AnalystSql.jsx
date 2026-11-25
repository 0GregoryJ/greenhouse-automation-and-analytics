import { useEffect, useId, useRef, useState } from "react";
import { IconCode } from "../layout/NavIcons.jsx";

export function AnalystSql({ sql, sqlError }) {
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const panelId = useId();
  const resetRef = useRef(null);

  useEffect(() => () => window.clearTimeout(resetRef.current), []);

  const canCopy =
    Boolean(sql) &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";

  async function copy() {
    window.clearTimeout(resetRef.current);
    try {
      await navigator.clipboard.writeText(sql);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
    resetRef.current = window.setTimeout(() => setCopyStatus(""), 2000);
  }

  return (
    <div className="ai-sql">
      <button
        type="button"
        className="ai-text-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <IconCode className="ai-text-button-icon" />
        {open ? "Hide SQL" : "Show SQL"}
      </button>

      {open && (
        <div id={panelId} className="ai-sql-panel">
          {sql ? (
            <>
              <div className="ai-sql-bar">
                <span>Compiled by MetricFlow from the validated query</span>
                {canCopy && (
                  <button type="button" className="ai-text-button" onClick={copy}>
                    {copyStatus === "Copied" ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
              <pre className="ai-sql-code" tabIndex={0} aria-label="Generated SQL">
                <code>{sql}</code>
              </pre>
            </>
          ) : (
            <p className="ai-sql-missing">
              {sqlError || "SQL is not available for this query."}
            </p>
          )}
          <span className="visually-hidden" aria-live="polite">
            {copyStatus}
          </span>
        </div>
      )}
    </div>
  );
}
