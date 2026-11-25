import { memo, useEffect, useRef, useState } from "react";
import { useAnalystQuery } from "../../hooks/useAnalystQuery.js";
import { IconArrowUpRight, IconSparkle } from "../layout/NavIcons.jsx";
import { AnalystComposer } from "./AnalystComposer.jsx";
import { AnalystResult } from "./AnalystResult.jsx";

const DEFAULT_TITLE = "Greenhouse Analyst";
const DEFAULT_DESCRIPTION =
  "Ask questions against governed metrics for trustworthy, AI-powered insights into greenhouse data.";

const DEFAULT_PROMPTS = [
  "How has my environment score trended this week?",
  "Which factor limited conditions the most today?",
  "When were soil moisture readings outside target?",
];

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function PanelHeading({ title, description, action }) {
  return (
    <header className="ai-panel-head">
      <div className="ai-panel-title-row">
        <span className="ai-panel-icon" aria-hidden="true">
          <IconSparkle className="ai-sparkle" />
        </span>
        <div className="ai-panel-title-text">
          <h2 className="ai-panel-heading">{title}</h2>
          <p className="ai-panel-copy">{description}</p>
        </div>
        {action}
      </div>
    </header>
  );
}

function AnalystHomeCard({ title, description, prompts, onOpenAnalyst }) {
  return (
    <section className="ai-panel ai-panel-home" aria-label={title}>
      <PanelHeading
        title={title}
        description={description}
        action={
          <button
            type="button"
            className="ai-home-link"
            onClick={() => onOpenAnalyst?.()}
            aria-label={`Open ${title}`}
            title={`Open ${title}`}
          >
            <IconArrowUpRight className="ai-home-link-icon" />
          </button>
        }
      />

      {prompts.length > 0 && (
        <div className="ai-prompts">
          <p className="ai-prompts-label">Try asking</p>
          <ul className="ai-prompt-list">
            {prompts.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  className="ai-prompt-chip"
                  onClick={() => onOpenAnalyst?.(prompt)}
                >
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AnalystWorkspace({
  title,
  description,
  prompts,
  analystIntent,
  onAnalystIntentHandled,
}) {
  const { status, activeQuestion, result, error, ask } = useAnalystQuery();
  const [draft, setDraft] = useState("");
  const cardRef = useRef(null);
  const inputRef = useRef(null);
  const handledIntentRef = useRef(null);
  const busy = status === "loading";

  function submit(question) {
    if (busy) return;
    if (ask(question)) setDraft("");
  }

  useEffect(() => {
    if (!analystIntent || handledIntentRef.current === analystIntent.id) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      handledIntentRef.current = analystIntent.id;
      cardRef.current?.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      inputRef.current?.focus({ preventScroll: true });
      if (analystIntent.question) ask(analystIntent.question);
      onAnalystIntentHandled?.();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [analystIntent, ask, onAnalystIntentHandled]);

  return (
    <section
      ref={cardRef}
      className="ai-panel ai-panel-workspace"
      aria-label={title}
    >
      <PanelHeading title={title} description={description} />

      <AnalystComposer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        busy={busy}
        prompts={status === "idle" ? prompts : []}
        inputRef={inputRef}
      />

      {status !== "idle" && (
        <div className="ai-output" aria-busy={busy}>
          <p className="ai-question">
            <span className="visually-hidden">Question: </span>
            {activeQuestion}
          </p>

          <div aria-live="polite">
            {busy && (
              <p className="ai-status">
                <span className="ai-status-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                Analyzing governed greenhouse data…
              </p>
            )}

            {status === "error" && (
              <div className="ai-error" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  className="ai-text-button"
                  onClick={() => ask(activeQuestion)}
                >
                  Try again
                </button>
              </div>
            )}
          </div>

          {status === "success" && result && <AnalystResult result={result} />}
        </div>
      )}
    </section>
  );
}

export const AiAnalystPanel = memo(function AiAnalystPanel({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  prompts = DEFAULT_PROMPTS,
  variant = "home",
  onOpenAnalyst,
  analystIntent = null,
  onAnalystIntentHandled,
}) {
  if (variant === "workspace") {
    return (
      <AnalystWorkspace
        title={title}
        description={description}
        prompts={prompts}
        analystIntent={analystIntent}
        onAnalystIntentHandled={onAnalystIntentHandled}
      />
    );
  }

  return (
    <AnalystHomeCard
      title={title}
      description={description}
      prompts={prompts}
      onOpenAnalyst={onOpenAnalyst}
    />
  );
});
