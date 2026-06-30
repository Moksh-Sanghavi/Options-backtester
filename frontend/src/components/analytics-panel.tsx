"use client";

/**
 * AnalyticsPanel — deeper breakdowns derived from a backtest's results:
 * exit-reason mix, Wall-vs-ORB attribution, a per-day P&L calendar heatmap, and
 * a strategy-vs-Nifty comparison. All computed client-side from the existing
 * results payload (plus the benchmark series the API now returns).
 */
import { useMemo } from "react";

import { BenchmarkPoint, EquityPoint, ResultsResponse, TradeLogRow } from "@/lib/api";
import { formatINRCompact, formatPct, formatSigned } from "@/lib/format";
import { cn } from "@/lib/utils";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function AnalyticsPanel({ results }: { results: ResultsResponse }) {
  return (
    <div className="glass-surface rounded-xl p-4">
      <h3 className="mb-4 text-sm font-semibold">Analytics</h3>
      <div className="grid gap-4 lg:grid-cols-2">
        <BenchmarkCard results={results} />
        <StrategyAttribution rows={results.trade_log} />
        <ExitReasonBreakdown rows={results.trade_log} />
      </div>
      <PnlCalendar equity={results.equity_curve} />
    </div>
  );
}

/* ── Strategy vs Nifty ─────────────────────────────────────────────────── */
function BenchmarkCard({ results }: { results: ResultsResponse }) {
  // Extract the symbol dynamically, default to Nifty
  const symbol = (results as any).symbol || "Nifty";

  const bench = results.benchmark ?? [];
  const { stratRet, benchRet } = useMemo(() => {
    const s = results.summary;
    const sr = s.return_on_capital_pct ?? 0;
    let br = 0;
    if (bench.length >= 2) {
      const first = bench[0].equity;
      const last = bench[bench.length - 1].equity;
      if (first) br = ((last - first) / first) * 100;
    }
    return { stratRet: sr, benchRet: br };
  }, [results.summary, bench]);

  const outperf = stratRet - benchRet;
  return (
    <div className="glass-card rounded-xl p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Strategy vs {symbol} (buy &amp; hold)
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Stat label="Strategy" value={formatPct(stratRet)} tone={stratRet >= 0 ? "pos" : "neg"} />
        <Stat label={`${symbol} B&H`} value={formatPct(benchRet)} tone={benchRet >= 0 ? "pos" : "neg"} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {outperf >= 0 ? "Outperformed by " : "Underperformed by "}
        <span className={cn("font-semibold", outperf >= 0 ? "text-positive" : "text-negative")}>
          {formatPct(Math.abs(outperf))}
        </span>{" "}
        over the period.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "pos" | "neg" }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("nums text-lg font-semibold", tone === "pos" ? "text-positive" : "text-negative")}>
        {value}
      </p>
    </div>
  );
}

/* ── Wall vs ORB attribution ───────────────────────────────────────────── */
function StrategyAttribution({ rows }: { rows: TradeLogRow[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const r of rows) {
      const key = r.strategy || "—";
      const g = map.get(key) ?? { pnl: 0, trades: 0, wins: 0 };
      g.pnl += r.net_pnl_inr;
      g.trades += 1;
      if (r.net_pnl_inr > 0) g.wins += 1;
      map.set(key, g);
    }
    return [...map.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  }, [rows]);

  return (
    <div className="glass-card rounded-xl p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Strategy attribution
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {groups.map(([name, g]) => (
          <div key={name} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="text-[11px] text-muted-foreground">
                {g.trades} trades · {formatPct((g.wins / g.trades) * 100)} win
              </p>
            </div>
            <span
              className={cn(
                "nums shrink-0 text-sm font-semibold",
                g.pnl >= 0 ? "text-positive" : "text-negative",
              )}
            >
              {formatSigned(g.pnl)}
            </span>
          </div>
        ))}
        {groups.length === 0 && <p className="text-xs text-muted-foreground">No trades.</p>}
      </div>
    </div>
  );
}

/* ── Exit-reason breakdown ─────────────────────────────────────────────── */
function ExitReasonBreakdown({ rows }: { rows: TradeLogRow[] }) {
  const data = useMemo(() => {
    const map = new Map<string, { count: number; pnl: number }>();
    for (const r of rows) {
      const key = r.exit_reason || "—";
      const g = map.get(key) ?? { count: 0, pnl: 0 };
      g.count += 1;
      g.pnl += r.net_pnl_inr;
      map.set(key, g);
    }
    const entries = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
    const max = Math.max(1, ...entries.map(([, g]) => g.count));
    return { entries, max };
  }, [rows]);

  return (
    <div className="glass-card rounded-xl p-4 lg:col-span-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Exit-reason breakdown
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {data.entries.map(([reason, g]) => (
          <div key={reason} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">{reason}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-muted/40">
              <div
                className="h-full rounded bg-primary/70"
                style={{ width: `${(g.count / data.max) * 100}%` }}
              />
            </div>
            <span className="nums w-8 shrink-0 text-right text-xs font-medium">{g.count}</span>
            <span
              className={cn(
                "nums w-20 shrink-0 text-right text-xs font-semibold",
                g.pnl >= 0 ? "text-positive" : "text-negative",
              )}
            >
              {formatSigned(g.pnl)}
            </span>
          </div>
        ))}
        {data.entries.length === 0 && <p className="text-xs text-muted-foreground">No exits.</p>}
      </div>
    </div>
  );
}

/* ── Per-day P&L calendar heatmap ──────────────────────────────────────── */
function PnlCalendar({ equity }: { equity: EquityPoint[] }) {
  const { months, maxAbs } = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const p of equity) byDate.set(p.date, p.pnl);
    const maxAbs = Math.max(1, ...equity.map((p) => Math.abs(p.pnl)));

    // Group into calendar months spanning the run.
    const ms = new Map<string, { year: number; month: number; total: number }>();
    for (const p of equity) {
      const [y, m] = p.date.split("-").map(Number);
      const key = `${y}-${m}`;
      const g = ms.get(key) ?? { year: y, month: m - 1, total: 0 };
      g.total += p.pnl;
      ms.set(key, g);
    }
    const months = [...ms.values()].sort((a, b) =>
      a.year === b.year ? a.month - b.month : a.year - b.year,
    );
    return { months, maxAbs, byDate };
  }, [equity]);

  const byDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of equity) m.set(p.date, p.pnl);
    return m;
  }, [equity]);

  if (equity.length === 0) return null;

  // Inline styles (Tailwind can't JIT dynamic opacity classes).
  const cellStyle = (pnl: number | undefined): React.CSSProperties => {
    if (pnl === undefined) {
      return { backgroundColor: "color-mix(in oklch, var(--muted) 25%, transparent)" };
    }
    const intensity = Math.min(1, Math.abs(pnl) / maxAbs);
    const pct = Math.round(20 + intensity * 70); // 20%–90%
    const color = pnl >= 0 ? "var(--positive)" : "var(--negative)";
    return { backgroundColor: `color-mix(in oklch, ${color} ${pct}%, transparent)` };
  };

  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Daily P&amp;L calendar
      </p>
      <div className="flex flex-wrap gap-4">
        {months.map(({ year, month, total }) => {
          const firstWeekday = new Date(year, month, 1).getDay();
          const days = new Date(year, month + 1, 0).getDate();
          const cells: (string | null)[] = [];
          for (let i = 0; i < firstWeekday; i++) cells.push(null);
          for (let d = 1; d <= days; d++) {
            cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
          }
          return (
            <div key={`${year}-${month}`} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium">
                  {MONTH_NAMES[month]} {String(year).slice(2)}
                </span>
                <span
                  className={cn(
                    "nums text-[10px] font-semibold",
                    total >= 0 ? "text-positive" : "text-negative",
                  )}
                >
                  {formatINRCompact(total)}
                </span>
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {cells.map((iso, i) =>
                  iso === null ? (
                    <div key={i} className="size-3.5" />
                  ) : (
                    <div
                      key={i}
                      title={`${iso}: ${byDate.has(iso) ? formatSigned(byDate.get(iso)!) : "no trade"}`}
                      className="size-3.5 rounded-[3px]"
                      style={cellStyle(byDate.get(iso))}
                    />
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
