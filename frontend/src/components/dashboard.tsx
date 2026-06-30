"use client";

/**
 * Dashboard — top-level client view. Fetches available datasets, owns the
 * backtest run/poll state via `useBacktest`, and lays out the configuration
 * panel beside the results area.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ConfigPanel } from "@/components/config-panel";
import { HistoryMenu } from "@/components/history-menu";
import { ResultsArea } from "@/components/results-area";
import { useBacktest } from "@/hooks/use-backtest";
import { ThemeToggle } from "@/components/theme-toggle";
import { BacktestRequest, fetchDatasets, fetchRun } from "@/lib/api";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  success: "Complete",
  error: "Error",
};

export function Dashboard() {
  const [datasets, setDatasets] = useState<string[]>([]);
  const { phase, progress, results, error, runState, run, reset, loadResults } =
    useBacktest();

  const handleLoadRun = (runId: string) => {
    fetchRun(runId)
      .then((stored) => {
        loadResults(stored.results, stored.id);
        toast.success("Loaded run", { description: stored.label });
      })
      .catch((err) =>
        toast.error("Could not load run", {
          description: err instanceof Error ? err.message : undefined,
        }),
      );
  };

  useEffect(() => {
    fetchDatasets()
      .then(setDatasets)
      .catch((err) => {
        toast.error("Could not load datasets", {
          description: err instanceof Error ? err.message : undefined,
        });
        setDatasets(["nifty"]);
      });
  }, []);

  useEffect(() => {
    if (phase === "error" && error) {
      toast.error("Backtest failed", { description: error });
    }
    if (phase === "success") {
      toast.success("Backtest complete");
    }
  }, [phase, error]);

  const handleRun = (request: BacktestRequest) => {
    toast.info("Backtest queued", { description: `Dataset: ${request.dataset}` });
    void run(request);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border bg-background/50 px-6 py-3.5 backdrop-blur-xl">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">
            Options Backtester  | Shatrunjaya Investment Managers LLP
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <HistoryMenu onLoad={handleLoadRun} />
          <StatusPill phase={phase} />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[380px_1fr]">
        <div className="border-b border-border p-4 lg:h-full lg:border-r lg:border-b-0 lg:overflow-hidden">
          <ConfigPanel
            datasets={datasets}
            isRunning={phase === "running"}
            onRun={handleRun}
          />
        </div>
        <div className="min-h-0 overflow-y-auto p-6">
          <ResultsArea
            phase={phase}
            progress={progress}
            results={results}
            error={error}
            runState={runState}
            onReset={reset}
          />
        </div>
      </div>
    </div>
  );
}

function StatusPill({ phase }: { phase: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        phase === "running" &&
          "border-primary/30 bg-primary/10 text-primary",
        phase === "success" &&
          "border-positive/30 bg-positive/10 text-positive",
        phase === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
        phase === "idle" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          phase === "running" && "animate-pulse bg-primary",
          phase === "success" && "bg-positive",
          phase === "error" && "bg-destructive",
          phase === "idle" && "bg-muted-foreground",
        )}
      />
      {PHASE_LABEL[phase] ?? phase}
    </span>
  );
}
