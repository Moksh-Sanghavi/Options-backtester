"use client";

/**
 * ResultsArea — renders the main content for each backtest phase:
 * idle (empty state), running (animated progress), error, and success
 * (headline performance tiles). The detailed equity/drawdown charts and the
 * trade-log table are layered in during Phase 4.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Gauge,
  LineChart,
  Loader2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { ChartsExplorer } from "@/components/charts-explorer";
import { GreeksPanel } from "@/components/greeks-panel";
import { TradeLogTable } from "@/components/trade-log-table";
import { DEFAULT_ANCHORS } from "@/lib/charts-data";
import { ProgressInfo, ResultsResponse, TaskState } from "@/lib/api";
import {
  formatINRCompact,
  formatNumber,
  formatPct,
  formatSigned,
} from "@/lib/format";
import { BacktestPhase } from "@/hooks/use-backtest";
import { cn } from "@/lib/utils";

interface ResultsAreaProps {
  phase: BacktestPhase;
  progress: ProgressInfo | null;
  results: ResultsResponse | null;
  error: string | null;
  runState: TaskState | null;
  onReset: () => void;
}

export function ResultsArea({
  phase,
  progress,
  results,
  error,
  runState,
  onReset,
}: ResultsAreaProps) {
  if (phase === "idle") return <IdleState />;
  if (phase === "running")
    return <RunningState progress={progress} runState={runState} />;
  if (phase === "error") return <ErrorState error={error} onReset={onReset} />;
  if (phase === "success" && results) return <SuccessState results={results} />;
  return <IdleState />;
}

/* ── Idle ─────────────────────────────────────────────────────────────── */
function IdleState() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <BarChart3 className="size-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-gradient text-xl font-semibold tracking-tight">
            Performance Explorer
          </h2>
          {/* Changed to max-w-3xl for the optimal reading width */}
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Configure your strategy on the left and run a simulation to generate
            a live tear sheet. Below is a sample of the interactive charts you’ll
            get. You can switch between equity, drawdown and spot price, and can even choose multiple charts together.
          </p>
        </div>
      </div>

      <ChartsExplorer anchors={DEFAULT_ANCHORS} sample />
    </div>
  );
}

/* ── Running ──────────────────────────────────────────────────────────── */
function RunningState({
  progress,
  runState,
}: {
  progress: ProgressInfo | null;
  runState: TaskState | null;
}) {
  const percent = progress?.percent ?? 0;
  const hasDays = (progress?.total ?? 0) > 0;
  const elapsed = useElapsed();

  // PENDING/RETRY mean the task is still sitting in the queue — a worker hasn't
  // picked it up yet (typically another backtest is running ahead of it). Once
  // a worker takes it, it's STARTED/PROGRESS: warming up (loading data) until
  // the first day count arrives, then processing days.
  const queued = !hasDays && (runState === "PENDING" || runState === "RETRY");

  const title = queued ? "Queued" : "Running simulation";
  const detail = hasDays
    ? `Processing day ${progress?.current} of ${progress?.total}`
    : queued
      ? "Waiting for a free worker — another backtest is running ahead of this one."
      : "Warming up the engine — loading market data…";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="glass-panel w-full max-w-md rounded-2xl p-8">
        <div className="flex items-center gap-3">
          {queued ? (
            <Clock className="size-5 animate-pulse text-muted-foreground" />
          ) : (
            <Loader2 className="size-5 animate-spin text-primary" />
          )}
          <div>
            <p className="text-sm font-semibold">{title}</p>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </div>
          {queued ? (
            <span className="ml-auto rounded-full bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border">
              In queue
            </span>
          ) : (
            <span className="nums font-heading ml-auto text-2xl font-semibold tabular-nums text-primary">
              {Math.round(percent)}%
            </span>
          )}
        </div>

        <Progress
          value={queued ? 0 : percent}
          className={cn("mt-5", !hasDays && "animate-pulse")}
        />

        <p className="mt-3 text-center text-xs text-muted-foreground">
          Elapsed {formatElapsed(elapsed)}
          {queued
            ? " · it'll start automatically when the worker frees up"
            : hasDays && " · large date ranges can take a few minutes"}
        </p>
      </div>
    </div>
  );
}

/** Seconds elapsed since the component mounted (ticks every second). */
function useElapsed(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

/** Format a second count as `m:ss` (or `s` under a minute). */
function formatElapsed(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ── Error ────────────────────────────────────────────────────────────── */
function ErrorState({
  error,
  onReset,
}: {
  error: string | null;
  onReset: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive ring-1 ring-destructive/20">
        <AlertTriangle className="size-7" />
      </div>
      <div className="max-w-md">
        <h2 className="text-lg font-semibold">Backtest failed</h2>
        <p className="mt-1 break-words text-sm text-muted-foreground">
          {error ?? "An unexpected error occurred."}
        </p>
      </div>
      <Button variant="outline" onClick={onReset}>
        Dismiss
      </Button>
    </div>
  );
}

/* ── Success ──────────────────────────────────────────────────────────── */
interface TileProps {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "neutral" | "positive" | "negative";
  sub?: string;
}

function MetricTile({ label, value, icon: Icon, tone = "neutral", sub }: TileProps) {
  return (
    <div className="glass-card group rounded-xl p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-lg ring-1 transition-colors",
            tone === "positive" && "bg-positive/10 text-positive ring-positive/20",
            tone === "negative" && "bg-negative/10 text-negative ring-negative/20",
            tone === "neutral" && "bg-muted/40 text-muted-foreground ring-border",
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
      <p
        className={cn(
          "nums font-heading mt-2.5 text-2xl font-semibold tracking-tight",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SuccessState({ results }: { results: ResultsResponse }) {
  const s = results.summary;
  // Shared "active day" so hovering the Equity/Drawdown curve crosshairs the
  // Greeks panel on the same date (and vice-versa).
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  // Memoise the derived chart inputs so a hover (which re-renders this component
  // via setHoverDate) doesn't hand ChartsExplorer fresh object/array identities —
  // that would re-fire its D3 draw effect and re-animate the curves every move.
  const chartAnchors = useMemo(
    () => ({
      initialCapital: s?.initial_capital ?? 0,
      totalPnl: s?.total_pnl ?? 0,
      maxDrawdown: Math.abs(s?.max_drawdown_inr ?? 0),
    }),
    [s?.initial_capital, s?.total_pnl, s?.max_drawdown_inr],
  );
  const equityDates = useMemo(
    () => results.equity_curve.map((p) => p.date),
    [results.equity_curve],
  );
  const equityValues = useMemo(
    () => results.equity_curve.map((p) => p.equity),
    [results.equity_curve],
  );
  const greeksData = results.greeks ?? [];

  // A valid run that simply produced no trades for the chosen parameters.
  if (!s || s.total_trades === undefined || results.trade_log.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-muted/40 text-muted-foreground ring-1 ring-border">
          <BarChart3 className="size-7" />
        </div>
        <div className="max-w-sm">
          <h2 className="text-lg font-semibold">No trades generated</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The backtest completed but produced no executions for these
            parameters or date range. Try widening the dates or relaxing the
            entry thresholds.
          </p>
        </div>
      </div>
    );
  }

  const pnlTone = s.total_pnl >= 0 ? "positive" : "negative";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-gradient text-xl font-semibold tracking-tight">
          Performance Tear Sheet
        </h2>
        <p className="text-sm text-muted-foreground">
          {s.total_days} trading days · {s.total_trades} executions
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <MetricTile
          label="Total PnL"
          value={formatSigned(s.total_pnl)}
          sub={`${formatNumber(s.total_pnl_points, 0)} pts`}
          icon={pnlTone === "positive" ? TrendingUp : TrendingDown}
          tone={pnlTone}
        />
        <MetricTile
          label="Max Drawdown"
          value={formatINRCompact(s.max_drawdown_inr)}
          sub={formatPct(s.max_drawdown_pct)}
          icon={TrendingDown}
          tone="negative"
        />
        <MetricTile
          label="Sharpe (daily)"
          value={formatNumber(s.sharpe, 2)}
          icon={Gauge}
        />
        <MetricTile
          label="Trade Win Rate"
          value={formatPct(s.trade_win_rate)}
          icon={BarChart3}
        />
        <MetricTile
          label="Profit Factor"
          value={s.profit_factor === null ? "∞" : formatNumber(s.profit_factor, 2)}
          icon={Gauge}
        />
        <MetricTile
          label="Initial Capital"
          value={formatINRCompact(s.initial_capital)}
          icon={LineChart}
        />
      </div>

      <ChartsExplorer
        anchors={chartAnchors}
        symbol={results.symbol}
        realDates={equityDates}
        realEquity={equityValues}
        onHoverDate={setHoverDate}
      />

      <GreeksPanel
        greeks={greeksData}
        symbol={results.symbol}
        syncDate={hoverDate}
        onHoverDate={setHoverDate}
      />

      <AnalyticsPanel results={results} />

      <DetailedMetrics metrics={results.metrics} />

      <TradeLogTable rows={results.trade_log} />
    </div>
  );
}

/* ── Detailed metrics ─────────────────────────────────────────────────── */
function DetailedMetrics({
  metrics,
}: {
  metrics: Record<string, number | string | null>;
}) {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return null;

  const render = (v: number | string | null) =>
    v === null
      ? "∞"
      : typeof v === "number"
        ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v)
        : v;

  return (
    <div className="glass-surface rounded-xl p-4">
      <h3 className="mb-3 text-sm font-semibold">All Metrics</h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(([key, value]) => (
          <div
            key={key}
            className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1"
          >
            <dt className="text-xs text-muted-foreground">{key}</dt>
            <dd className="nums text-sm font-medium">{render(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
