"use client";

/**
 * GreeksPanel — the portfolio's daily risk profile (Delta, Gamma, Theta, Vega).
 *
 * Sits between the Charts Explorer and the Analytics panel. Four sparkline-style
 * charts are laid out in a responsive 2×2 grid, each plotting one Greek's
 * aggregate exposure over the backtest's trading days against a shared daily
 * axis. The series come straight from the backend Greeks pipeline
 * (`results.greeks`), where IV is implied from each leg's traded premium and the
 * per-contract Greeks are signed + size-scaled into a portfolio total.
 *
 * Two crosshair sources are unified into one "active day":
 *   • `syncDate` — pushed down from the Charts Explorer hover, so moving the
 *     cursor over the Equity/Drawdown curve drops a vertical crosshair on the
 *     same date across all four Greeks (axis-sync).
 *   • local hover — hovering a Greek chart directly crosshairs all four and
 *     raises a tooltip with that Greek's value and the underlying spot.
 *
 * Rendering is declarative SVG with memoised geometry (one line + one area path
 * per chart), so re-renders on hover only touch the lightweight crosshair layer
 * — cheap even for multi-year datasets.
 */
import { scaleLinear } from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sigma } from "lucide-react";

import { GreeksPoint } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ── Greek metadata ──────────────────────────────────────────────────────── */
type GreekKey = "delta" | "gamma" | "theta" | "vega";

interface GreekMeta {
  key: GreekKey;
  label: string;
  symbol: string;
  color: string;
  /** One-line read on what positive/negative exposure means. */
  hint: string;
  /** Decimal places for the value readout. */
  digits: number;
}

const GREEKS: GreekMeta[] = [
  { key: "delta", label: "Delta", symbol: "Δ", color: "#60a5fa", hint: "Directional exposure (× spot)", digits: 1 },
  { key: "gamma", label: "Gamma", symbol: "Γ", color: "#c084fc", hint: "Delta sensitivity to spot", digits: 4 },
  { key: "theta", label: "Theta", symbol: "Θ", color: "#fb7185", hint: "P&L decay per day", digits: 1 },
  { key: "vega", label: "Vega", symbol: "V", color: "#fbbf24", hint: "Sensitivity to +1% IV", digits: 1 },
];

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Compact signed number for headline/tooltip readouts (e.g. +1.2K, −340). */
function fmtCompact(v: number, digits: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${a.toFixed(digits)}`;
}

const fmtSpot = (v: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v)}`;

interface GreeksPanelProps {
  greeks: GreeksPoint[];
  /** Underlying symbol, for the tooltip's spot row label. */
  symbol?: string;
  /** Date the Charts Explorer is currently hovering (drives the synced crosshair). */
  syncDate?: string | null;
  /** Emit the hovered date so a sibling chart can mirror the crosshair. */
  onHoverDate?: (date: string | null) => void;
}

export function GreeksPanel({
  greeks,
  symbol = "NIFTY",
  syncDate = null,
  onHoverDate,
}: GreeksPanelProps) {
  // Local hover (this panel) takes precedence over the external sync date.
  const [localHover, setLocalHover] = useState<number | null>(null);

  const dateIndex = useMemo(() => {
    const m = new Map<string, number>();
    greeks.forEach((g, i) => m.set(g.date, i));
    return m;
  }, [greeks]);

  const syncIndex = syncDate != null ? dateIndex.get(syncDate) ?? null : null;
  const activeIndex = localHover ?? syncIndex;

  const handleHover = useCallback(
    (i: number | null) => {
      setLocalHover(i);
      onHoverDate?.(i == null ? null : greeks[i]?.date ?? null);
    },
    [greeks, onHoverDate],
  );

  if (greeks.length === 0) {
    return (
      <div className="glass-surface rounded-2xl p-5">
        <PanelHeader count={0} />
        <div className="mt-6 flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-muted-foreground">
          No open option positions to profile for this run.
        </div>
      </div>
    );
  }

  return (
    <div className="glass-surface rounded-2xl p-5">
      <PanelHeader count={greeks.length} />
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {GREEKS.map((meta) => (
          <GreekChart
            key={meta.key}
            meta={meta}
            points={greeks}
            symbol={symbol}
            activeIndex={activeIndex}
            onHover={handleHover}
          />
        ))}
      </div>
    </div>
  );
}

function PanelHeader({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
          <Sigma className="size-4" />
        </div>
        <div>
          <h3 className="font-heading text-[15px] font-semibold leading-tight">
            Greeks Exposure
          </h3>
          <p className="text-xs text-muted-foreground">
            Aggregate portfolio risk · Black-Scholes
          </p>
        </div>
      </div>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">
        {count} trading days · synchronised daily axis
      </span>
    </div>
  );
}

/* ── Single Greek mini-chart ─────────────────────────────────────────────── */
const M = { top: 18, right: 12, bottom: 16, left: 12 };
const H = 150;

interface GreekChartProps {
  meta: GreekMeta;
  points: GreeksPoint[];
  symbol: string;
  activeIndex: number | null;
  onHover: (i: number | null) => void;
}

function GreekChart({ meta, points, symbol, activeIndex, onHover }: GreekChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  // Responsive width (matches Charts Explorer's ResizeObserver pattern).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(40, width - M.left - M.right);
  const innerH = H - M.top - M.bottom;

  // Geometry is memoised on data + width — hover never recomputes it.
  const geom = useMemo(() => {
    const values = points.map((p) => p[meta.key]);
    const n = values.length;

    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    const y = scaleLinear().domain([min - pad, max + pad]).range([innerH, 0]);
    // Single point → centre it; otherwise spread indices across the width.
    const x = (i: number) => (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);

    const linePts = values.map((v, i) => [x(i), y(v)] as const);
    const line = linePts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
    const baseline = y(0);
    const area =
      `M${x(0)},${baseline}` +
      linePts.map(([px, py]) => `L${px},${py}`).join("") +
      `L${x(n - 1)},${baseline}Z`;

    return { x, y, line, area, baseline, n };
  }, [points, meta.key, innerW, innerH]);

  // Map a pointer x back to the nearest day index.
  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const { n } = geom;
      const i = n <= 1 ? 0 : Math.round((mx / innerW) * (n - 1));
      onHover(Math.max(0, Math.min(n - 1, i)));
    },
    [geom, innerW, onHover],
  );

  const active =
    activeIndex != null && activeIndex >= 0 && activeIndex < geom.n
      ? activeIndex
      : null;
  const activePt = active != null ? points[active] : null;
  const ax = active != null ? geom.x(active) : 0;
  const ay = active != null ? geom.y(points[active][meta.key]) : 0;

  const gradId = `greek-grad-${meta.key}`;
  const latest = points[points.length - 1]?.[meta.key] ?? 0;

  // Keep the tooltip inside the chart by flipping it left past the midpoint.
  const tipRight = ax > innerW / 2;

  return (
    <div className="glass-card rounded-xl p-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold" style={{ color: meta.color }}>
            {meta.symbol}
          </span>
          <span className="text-xs font-medium text-foreground">{meta.label}</span>
        </div>
        <span
          className="nums text-sm font-semibold tabular-nums"
          style={{ color: meta.color }}
        >
          {fmtCompact(latest, meta.digits)}
        </span>
      </div>
      <p className="mb-1 text-[10px] text-muted-foreground">{meta.hint}</p>

      <div ref={containerRef} className="relative w-full">
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`${meta.label} exposure over time`}
          className="block overflow-visible"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={meta.color} stopOpacity={0.34} />
              <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            {/* Zero reference line — Greeks swing through zero. */}
            <line
              x1={0}
              x2={innerW}
              y1={geom.baseline}
              y2={geom.baseline}
              stroke="rgba(255,255,255,0.18)"
              strokeDasharray="3 3"
            />
            <path d={geom.area} fill={`url(#${gradId})`} />
            <path
              d={geom.line}
              fill="none"
              stroke={meta.color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              shapeRendering="geometricPrecision"
            />

            {/* Synced crosshair + focus dot. */}
            {active != null && (
              <g pointerEvents="none">
                <line
                  x1={ax}
                  x2={ax}
                  y1={0}
                  y2={innerH}
                  stroke="rgba(255,255,255,0.28)"
                  strokeDasharray="3 3"
                />
                <circle
                  cx={ax}
                  cy={ay}
                  r={3.5}
                  fill={meta.color}
                  stroke="rgba(0,0,0,0.5)"
                  strokeWidth={1.5}
                />
              </g>
            )}

            {/* Pointer capture overlay. */}
            <rect
              width={innerW}
              height={innerH}
              fill="transparent"
              style={{ cursor: "crosshair" }}
              onPointerMove={onPointerMove}
              onPointerLeave={() => onHover(null)}
            />
          </g>
        </svg>

        {/* Tooltip — Greek value + underlying spot on the active day. */}
        {activePt && (
          <div
            className="ce-tooltip pointer-events-none absolute top-1 z-20"
            style={tipRight ? { right: 4 } : { left: 4 }}
          >
            <div className="ce-tt-date">{fmtDate(activePt.date)}</div>
            <div className="ce-tt-row">
              <span style={{ color: meta.color }}>
                {meta.symbol} {meta.label}
              </span>
              <b>{fmtCompact(activePt[meta.key], meta.digits)}</b>
            </div>
            <div className="ce-tt-row">
              <span>{symbol} spot</span>
              <b>{fmtSpot(activePt.spot)}</b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
