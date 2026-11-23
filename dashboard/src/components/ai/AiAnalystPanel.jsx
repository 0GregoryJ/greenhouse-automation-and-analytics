import { IconSparkle } from "../layout/NavIcons.jsx";

const DEFAULT_PROMPTS = [
  "How has my environment score trended this week?",
  "Which factor limited conditions the most today?",
  "When were soil moisture readings outside target?",
];

/**
 * Coming-soon analyst surface styled like governed / semantic-layer copilots:
 * constrained prompts, metric grounding, no free-form warehouse access yet.
 */
export function AiAnalystPanel({
  title = "Greenhouse analyst",
  description = "Ask questions against governed metrics for trustworthy, AI-powered insights into greenhouse data.",
  prompts = DEFAULT_PROMPTS,
  variant = "full",
}) {
  return (
    <section
      className={
        variant === "compact" ? "ai-panel ai-panel-compact" : "ai-panel"
      }
      aria-label={`${title} (coming soon)`}
    >
      <header className="ai-panel-head">
        <div className="ai-panel-title-row">
          <span className="ai-panel-icon" aria-hidden="true">
            <IconSparkle className="ai-sparkle" />
          </span>
          <div>
            <div className="ai-panel-heading">
              <h2>{title}</h2>
              <span className="ai-badge">Coming soon</span>
            </div>
            <p className="ai-panel-copy">{description}</p>
          </div>
        </div>
      </header>

      <div className="ai-composer" aria-disabled="true">
        <label className="visually-hidden" htmlFor="ai-ask-disabled">
          Ask a question
        </label>
        <textarea
          id="ai-ask-disabled"
          className="ai-input"
          rows={variant === "compact" ? 2 : 3}
          disabled
          placeholder="Ask a question about greenhouse metrics…"
        />
        <button type="button" className="ai-send" disabled aria-label="Send">
          →
        </button>
      </div>

      <div className="ai-prompts">
        <p className="ai-prompts-label">Example questions</p>
        <ul className="ai-prompt-list">
          {prompts.map((prompt) => (
            <li key={prompt}>
              <button type="button" className="ai-prompt-chip" disabled>
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {variant === "full" && (
        <p className="ai-footnote">
          Designed for a semantic layer: verified metrics, clear definitions,
          and citation-backed answers once warehouse models are ready.
        </p>
      )}
    </section>
  );
}
