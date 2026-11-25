import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAnalystAnswer } from "../services/analystApi.js";

export const QUESTION_MIN_LENGTH = 3;
export const QUESTION_MAX_LENGTH = 1000;

/**
 * Single-question analyst state: each submission replaces the previous
 * analysis (the backend has no conversational memory).
 */
export function useAnalystQuery() {
  const [status, setStatus] = useState("idle");
  const [activeQuestion, setActiveQuestion] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const requestIdRef = useRef(0);

  /** Starts a request and returns whether the question was accepted. */
  const ask = useCallback((rawQuestion) => {
    const question = String(rawQuestion ?? "").trim();
    if (question.length < QUESTION_MIN_LENGTH) return false;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;

    setActiveQuestion(question);
    setResult(null);
    setError(null);
    setStatus("loading");

    fetchAnalystAnswer(question.slice(0, QUESTION_MAX_LENGTH), controller.signal)
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        setResult(data);
        setStatus("success");
      })
      .catch((err) => {
        if (err?.name === "AbortError" || requestId !== requestIdRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : "The analyst request failed.");
        setStatus("error");
      });

    return true;
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { status, activeQuestion, result, error, ask };
}
