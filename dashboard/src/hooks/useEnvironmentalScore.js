import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCurrentScore } from "../services/environmentApi.js";

const POLL_MS = 3_000;

export function useEnvironmentalScore({ gatewayId, enabled = true } = {}) {
  const [score, setScore] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (!gatewayId) {
      setScore(null);
      setStatus("idle");
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await fetchCurrentScore(gatewayId, controller.signal);
      setScore(data);
      setStatus("ok");
      setError(null);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setStatus((prev) => (prev === "ok" ? "ok" : "error"));
      setError(err instanceof Error ? err.message : "Failed to load score");
    }
  }, [gatewayId]);

  useEffect(() => {
    if (!enabled || !gatewayId) {
      setScore(null);
      setStatus("idle");
      setError(null);
      return undefined;
    }

    setStatus((prev) => (prev === "ok" ? prev : "loading"));
    load();
    const id = window.setInterval(load, POLL_MS);

    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
    };
  }, [enabled, gatewayId, load]);

  return { score, status, error, refresh: load };
}
