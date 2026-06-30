"use client";

/**
 * useBacktest — submission + polling state machine for a backtest run.
 *
 * Flow: `run(request)` POSTs to /start, captures the task_id, then polls
 * /status on an interval. When the task reaches SUCCESS it fetches /results;
 * on FAILURE it surfaces the error. Cleans up its interval on unmount.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BacktestRequest,
  ProgressInfo,
  ResultsResponse,
  TaskState,
  getBacktestResults,
  getBacktestStatus,
  startBacktest,
} from "@/lib/api";

/** High-level phase of the hook, independent of raw Celery states. */
export type BacktestPhase = "idle" | "running" | "success" | "error";

export interface UseBacktestState {
  phase: BacktestPhase;
  taskId: string | null;
  progress: ProgressInfo | null;
  results: ResultsResponse | null;
  error: string | null;
  /**
   * The latest raw Celery task state while running. Lets the UI tell a task
   * still waiting in the queue (`PENDING` — another run is ahead of it) apart
   * from one a worker has already picked up and is warming up (`STARTED` /
   * `PROGRESS`). Null when idle.
   */
  runState: TaskState | null;
}

const POLL_INTERVAL_MS = 1200;

export function useBacktest() {
  const [state, setState] = useState<UseBacktestState>({
    phase: "idle",
    taskId: null,
    progress: null,
    results: null,
    error: null,
    runState: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const clearPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPolling();
    };
  }, [clearPolling]);

  /** Reset back to the idle state and stop any polling. */
  const reset = useCallback(() => {
    clearPolling();
    setState({
      phase: "idle",
      taskId: null,
      progress: null,
      results: null,
      error: null,
      runState: null,
    });
  }, [clearPolling]);

  /** Load a finished results payload directly (e.g. reopening a stored run). */
  const loadResults = useCallback(
    (results: ResultsResponse, taskId: string | null = null) => {
      clearPolling();
      setState({
        phase: "success",
        taskId,
        progress: { current: 1, total: 1, percent: 100 },
        results,
        error: null,
        runState: "SUCCESS",
      });
    },
    [clearPolling],
  );

  /** Submit a backtest and begin polling for completion. */
  const run = useCallback(
    async (request: BacktestRequest) => {
      clearPolling();
      setState({
        phase: "running",
        taskId: null,
        progress: null,
        results: null,
        error: null,
        // Let the first status poll classify queued vs warming-up, so a run
        // that starts immediately doesn't flash a misleading "Queued".
        runState: null,
      });

      let taskId: string;
      try {
        const start = await startBacktest(request);
        taskId = start.task_id;
      } catch (err) {
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: "error",
          error: err instanceof Error ? err.message : "Failed to start backtest.",
        }));
        return;
      }

      if (!mountedRef.current) return;
      setState((s) => ({ ...s, taskId }));

      const poll = async () => {
        try {
          const status = await getBacktestStatus(taskId);
          if (!mountedRef.current) return;

          // Always reflect the raw Celery state so the UI can show "queued"
          // (PENDING) vs "warming up" (STARTED / PROGRESS with no days yet).
          setState((s) => ({ ...s, runState: status.status }));

          if (status.status === "PROGRESS") {
            setState((s) => ({ ...s, progress: status.progress }));
          } else if (status.status === "SUCCESS") {
            clearPolling();
            const results = await getBacktestResults(taskId);
            if (!mountedRef.current) return;
            setState((s) => ({
              ...s,
              phase: "success",
              progress: { current: 1, total: 1, percent: 100 },
              results,
            }));
          } else if (status.status === "FAILURE") {
            clearPolling();
            setState((s) => ({
              ...s,
              phase: "error",
              error: status.error ?? "The backtest task failed.",
            }));
          }
          // PENDING / STARTED / RETRY: keep polling.
        } catch (err) {
          clearPolling();
          if (!mountedRef.current) return;
          setState((s) => ({
            ...s,
            phase: "error",
            error: err instanceof Error ? err.message : "Polling failed.",
          }));
        }
      };

      // Kick off immediately, then on an interval.
      void poll();
      intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    },
    [clearPolling],
  );

  return { ...state, run, reset, loadResults };
}
