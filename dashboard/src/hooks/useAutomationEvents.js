import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRecentAutomationEvents } from "../services/automationApi.js";

const POLL_MS = 5_000;

export function useAutomationEvents({ enabled = true } = {}) {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await fetchRecentAutomationEvents(controller.signal);
      setEvents(data);
      setStatus("ok");
      setError(null);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setStatus((prev) => (prev === "ok" ? "ok" : "error"));
      setError(
        err instanceof Error ? err.message : "Failed to load automation events"
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    load();
    const id = window.setInterval(load, POLL_MS);

    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
    };
  }, [enabled, load]);

  return { events, status, error, refresh: load };
}
