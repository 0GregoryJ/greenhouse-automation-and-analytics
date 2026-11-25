import { useId } from "react";
import {
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
} from "../../hooks/useAnalystQuery.js";

export function AnalystComposer({
  value,
  onChange,
  onSubmit,
  busy,
  prompts = [],
  inputRef,
}) {
  const inputId = useId();
  const promptsId = useId();
  const canSubmit = !busy && value.trim().length >= QUESTION_MIN_LENGTH;

  function submit(event) {
    event.preventDefault();
    if (canSubmit) onSubmit(value);
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (canSubmit) onSubmit(value);
  }

  return (
    <div className="ai-composer-block">
      <form className="ai-composer" onSubmit={submit}>
        <label className="visually-hidden" htmlFor={inputId}>
          Ask a question about your greenhouse data
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          className="ai-input"
          rows={2}
          maxLength={QUESTION_MAX_LENGTH}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about your greenhouse data..."
          enterKeyHint="send"
        />
        <button
          type="submit"
          className="ai-send"
          disabled={!canSubmit}
          aria-label={busy ? "Analyzing" : "Ask"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="ai-send-icon">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 19V5M6 11l6-6 6 6"
            />
          </svg>
        </button>
      </form>

      {prompts.length > 0 && (
        <div className="ai-prompts">
          <p className="ai-prompts-label" id={promptsId}>
            Try asking
          </p>
          <ul className="ai-prompt-list" aria-labelledby={promptsId}>
            {prompts.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  className="ai-prompt-chip"
                  disabled={busy}
                  onClick={() => onSubmit(prompt)}
                >
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
