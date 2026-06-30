"use client";

/**
 * ChartsExplorer — an interactive, D3-powered multi-series chart surface.
 *
 * Toggle chips select any combination of three series that share ONE
 * synchronised daily time axis:
 *   • Equity Curve   — cumulative account equity (₹).
 *   • Drawdown       — daily drawdown from peak (% of capital).
 *   • Spot Price     — the underlying; OHLC candlesticks when shown alone,
 *                      a simple line when overlaid with other series.
 *
 * Overlaid series keep their real values via a dual Y-axis: a ₹-denominated
 * series reads off the left axis and drawdown % off the right (a third,
 * same-unit series auto-fits with no dedicated axis — its values live in the
 * tooltip). Toggling re-animates; hovering reveals a shared crosshair whose
 * tooltip lists every active series for the hovered day.
 *
 * Data is generated from the backtest anchors (see lib/charts-data) so the
 * series are internally consistent.
 */
import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CandlestickChart, LineChart, TrendingDown } from "lucide-react";

import {
  ChartAnchors,
  DEFAULT_ANCHORS,
  DayPoint,
  generateChartSeries,
} from "@/lib/charts-data";
import { cn } from "@/lib/utils";

type SeriesKey = "equity" | "drawdown" | "spot";

const COLOR = {
  equity: "#34d399",
  drawdown: "#fb7185",
  spot: "#60a5fa",
  grid: "rgba(255,255,255,0.055)",
  axis: "rgba(235,235,245,0.45)",
  zero: "rgba(255,255,255,0.28)",
};



/** Fixed iteration order used for axis assignment and stacking. */
const SERIES_ORDER: SeriesKey[] = ["equity", "spot", "drawdown"];

const MARGIN = { top: 18, right: 26, bottom: 38, left: 70 };
const HEIGHT = 384;

const parseDate = d3.timeParse("%Y-%m-%d");
const fmtAxisDate = d3.timeFormat("%b %d");
const fmtFullDate = d3.timeFormat("%a, %b %d %Y");

function inrCompact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1)}K`;
  return `${sign}₹${a.toFixed(0)}`;
}
const inrFull = (v: number) =>
  `${v < 0 ? "-" : ""}₹${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(Math.abs(v))}`;

/** Per-series value accessor, axis tick formatter, and tooltip formatter. */
const SERIES_FNS: Record<
  SeriesKey,
  {
    value: (d: DayPoint) => number;
    axisFmt: (v: number) => string;
    tipFmt: (d: DayPoint) => string;
  }
> = {
  equity: {
    value: (d) => d.equity,
    axisFmt: inrCompact,
    tipFmt: (d) => inrFull(d.equity),
  },
  drawdown: {
    value: (d) => d.drawdownPct,
    axisFmt: (v) => `${v.toFixed(0)}%`,
    tipFmt: (d) => `${d.drawdownPct.toFixed(3)}%`,
  },
  spot: {
    value: (d) => d.close,
    axisFmt: (v) => v.toFixed(0),
    tipFmt: (d) => inrFull(d.close),
  },
};

interface ChartsExplorerProps {
  anchors?: ChartAnchors;
  /** Optional real series to anchor the equity/drawdown views to. */
  realDates?: string[];
  realEquity?: number[];
  /** Small "Sample data" hint shown in idle/demo mode. */
  sample?: boolean;
  /** Dynamic dataset symbol passed from backend */
  symbol?: string;
  /** Emit the hovered ISO date (or null on leave) so a sibling chart — e.g. the
   *  Greeks panel — can mirror the crosshair on the same day (axis-sync). */
  onHoverDate?: (date: string | null) => void;
}

export function ChartsExplorer({
  anchors = DEFAULT_ANCHORS,
  realDates,
  realEquity,
  sample = false,
  symbol = "NIFTY", // Provide a fallback
  onHoverDate,
}: ChartsExplorerProps) {
  
  // Define metadata inside the component so it has access to the symbol
  const currentSeriesMeta = useMemo<Record<
    SeriesKey,
    {
      label: string;
      icon: React.ComponentType<{ className?: string }>;
      unit: string;
      color: string;
    }
  >>(() => ({
    equity: { label: "Equity", icon: LineChart, unit: "Account balance (₹)", color: COLOR.equity },
    drawdown: { label: "Drawdown", icon: TrendingDown, unit: "% of capital", color: COLOR.drawdown },
    spot: { label: "Spot Price", icon: CandlestickChart, unit: `${symbol.toUpperCase()} spot (₹)`, color: COLOR.spot },
  }), [symbol]);
  // Which series are overlaid. At least one is always on.
  const [active, setActive] = useState<Record<SeriesKey, boolean>>({
    equity: true,
    drawdown: false,
    spot: false,
  });
  const [width, setWidth] = useState(720);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Latest hover callback in a ref so the D3 draw effect can fire it without
  // listing it as a dependency (which would redraw the whole plot on prop changes).
  const onHoverDateRef = useRef(onHoverDate);
  onHoverDateRef.current = onHoverDate;

  const series = useMemo(
    () => generateChartSeries(anchors, { realDates, realEquity }),
    [anchors, realDates, realEquity],
  );

  const activeKeys = useMemo(
    () => SERIES_ORDER.filter((k) => active[k]),
    [active],
  );

  /** Toggle a series, but never let the user turn off the last one. */
  const toggle = (k: SeriesKey) =>
    setActive((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      if (!next.equity && !next.drawdown && !next.spot) return prev;
      return next;
    });

  // Responsive width.
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

  // Draw / redraw whenever data, active series, or width changes.
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const tooltip = d3.select(tooltipRef.current);
    if (!svgRef.current || width <= 0) return;

    const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const pts = series.points;

    const single = activeKeys.length === 1;
    const spotSolo = single && activeKeys[0] === "spot";

    svg.selectAll("*").remove();
    const defs = svg.append("defs");

    const root = svg
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    // Cross-fade the whole plot in on every (re)render → smooth toggles.
    root.attr("opacity", 0).transition().duration(420).attr("opacity", 1);

    // Shared band scale → identical daily axis across all series.
    const x = d3
      .scaleBand<string>()
      .domain(pts.map((p) => p.date))
      .range([0, innerW])
      .paddingInner(0.32)
      .paddingOuter(0.18);
    const cx = (d: DayPoint) => (x(d.date) ?? 0) + x.bandwidth() / 2;

    // ── Per-series Y scales (each auto-fit to its own data range) ──────────
    const makeScale = (k: SeriesKey): d3.ScaleLinear<number, number> => {
      if (k === "equity") {
        return d3
          .scaleLinear()
          .domain([
            (d3.min(pts, (p) => p.equity) ?? 0) * 0.985,
            (d3.max(pts, (p) => p.equity) ?? 1) * 1.012,
          ])
          .range([innerH, 0]);
      }
      if (k === "drawdown") {
        const minDd = d3.min(pts, (p) => p.drawdownPct) ?? -1;
        return d3
          .scaleLinear()
          .domain([minDd * 1.18, 0])
          .range([innerH, 0])
          .nice();
      }
      // spot — pad around the OHLC envelope.
      return d3
        .scaleLinear()
        .domain([
          (d3.min(pts, (p) => p.low) ?? 0) - 60,
          (d3.max(pts, (p) => p.high) ?? 1) + 60,
        ])
        .range([innerH, 0]);
    };

    const scales = new Map<SeriesKey, d3.ScaleLinear<number, number>>();
    activeKeys.forEach((k) => scales.set(k, makeScale(k)));

    // Axis assignment: a ₹ series on the left, drawdown % on the right.
    const leftKey: SeriesKey = active.equity
      ? "equity"
      : active.spot
        ? "spot"
        : "drawdown";
    let rightKey: SeriesKey | null = null;
    if (active.drawdown && leftKey !== "drawdown") {
      rightKey = "drawdown";
    } else {
      rightKey = activeKeys.find((k) => k !== leftKey) ?? null;
    }

    // ── Axes + grid ───────────────────────────────────────────────────────
    // X axis (shared) — label every ~Nth day to avoid crowding.
    const step = Math.ceil(pts.length / 8);
    const xTickVals = pts.filter((_, i) => i % step === 0).map((p) => p.date);
    const xAxis = root
      .append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues(xTickVals)
          .tickSize(0)
          .tickPadding(10)
          .tickFormat((d) => {
            const dt = parseDate(d as string);
            return dt ? fmtAxisDate(dt) : (d as string);
          }),
      );
    xAxis.select(".domain").attr("stroke", "rgba(255,255,255,0.1)");
    xAxis.selectAll("text").attr("fill", COLOR.axis).attr("font-size", 11);

    // Horizontal grid keyed off the left axis scale.
    const gridY = scales.get(leftKey)!;
    root
      .append("g")
      .attr("class", "grid")
      .selectAll("line")
      .data(gridY.ticks(6))
      .join("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", (d) => gridY(d))
      .attr("y2", (d) => gridY(d))
      .attr("stroke", COLOR.grid)
      .attr("stroke-dasharray", "3 4");

    // Left Y axis (coloured to its series).
    const leftAxis = root.append("g").call(
      d3
        .axisLeft(scales.get(leftKey)!)
        .ticks(6)
        .tickSize(0)
        .tickPadding(12)
        .tickFormat((d) => SERIES_FNS[leftKey].axisFmt(d as number)),
    );
    leftAxis.select(".domain").remove();
    leftAxis
      .selectAll("text")
      .attr("fill", rightKey ? currentSeriesMeta[leftKey].color : COLOR.axis)
      .attr("font-size", 11);

    // Right Y axis (only when a second series needs its own scale).
    if (rightKey) {
      const rightAxis = root
        .append("g")
        .attr("transform", `translate(${innerW},0)`)
        .call(
          d3
            .axisRight(scales.get(rightKey)!)
            .ticks(6)
            .tickSize(0)
            .tickPadding(12)
            .tickFormat((d) => SERIES_FNS[rightKey!].axisFmt(d as number)),
        );
      rightAxis.select(".domain").remove();
      rightAxis
        .selectAll("text")
        .attr("fill", currentSeriesMeta[rightKey].color)
        .attr("font-size", 11);
    }

    // Tooltip helpers. `anchorX`/`anchorY` are the reference point in container
    // coords; the tooltip normally sits to the right of it, but flips to the left
    // (and is clamped both ways) when it would otherwise spill outside the plot —
    // so hovering the last point keeps the readout on-screen.
    const placeTooltip = (anchorX: number, anchorY: number) => {
      const node = tooltipRef.current;
      const container = containerRef.current;
      if (!node || !container) return;
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      let left = anchorX + 16;
      if (left + tw > cw - 8) left = anchorX - tw - 16; // flip to the left side
      left = Math.max(8, Math.min(left, cw - tw - 8));
      const top = Math.max(8, Math.min(anchorY, ch - th - 8));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
    };
    const showTooltip = (html: string, anchorX: number, anchorY: number) => {
      tooltip.style("opacity", "1").html(html);
      placeTooltip(anchorX, anchorY);
    };
    const hideTooltip = () => tooltip.style("opacity", "0");

    // ── Spot candlesticks (only when Spot is the lone series) ─────────────
    if (spotSolo) {
      const y = scales.get("spot")!;
      const candleW = Math.min(x.bandwidth(), 22);
      const g = root
        .append("g")
        .selectAll("g")
        .data(pts)
        .join("g")
        .attr("transform", (d) => `translate(${cx(d)},0)`)
        .style("cursor", "crosshair");

      const isLast = (_d: DayPoint, i: number) => i === series.lastIndex;
      const color = (d: DayPoint) => (d.close >= d.open ? COLOR.equity : COLOR.drawdown);

      g.append("line")
        .attr("x1", 0).attr("x2", 0)
        .attr("y1", (d) => y(d.high)).attr("y2", (d) => y(d.high))
        .attr("stroke", color)
        .attr("stroke-width", (d, i) => (isLast(d, i) ? 1.6 : 1.1))
        .transition().delay((_d, i) => 120 + i * 22).duration(260)
        .attr("y2", (d) => y(d.low));

      g.append("rect")
        .attr("x", -candleW / 2)
        .attr("width", candleW)
        .attr("rx", 1.5)
        .attr("y", (d) => y(d.open))
        .attr("height", 0)
        .attr("fill", color)
        .attr("fill-opacity", (d, i) => (isLast(d, i) ? 1 : 0.85))
        .attr("stroke", (d, i) => (isLast(d, i) ? "#fff" : color(d)))
        .attr("stroke-opacity", (d, i) => (isLast(d, i) ? 0.85 : 0.3))
        .attr("stroke-width", (d, i) => (isLast(d, i) ? 1.4 : 0.8))
        .transition().delay((_d, i) => 120 + i * 22).duration(300)
        .attr("y", (d) => y(Math.max(d.open, d.close)))
        .attr("height", (d) => Math.max(1.5, Math.abs(y(d.open) - y(d.close))));

      g.on("pointerenter", function (event, d) {
        d3.select(this).select("rect").attr("fill-opacity", 1);
        onHoverDateRef.current?.(d.date);
        const [mx, my] = d3.pointer(event, containerRef.current);
        showTooltip(
          `<div class="ce-tt-date">${fmtFullDate(parseDate(d.date)!)}</div>
           <div class="ce-tt-ohlc">
             <span>O</span><b>${d.open.toFixed(1)}</b>
             <span>H</span><b style="color:${COLOR.equity}">${d.high.toFixed(1)}</b>
             <span>L</span><b style="color:${COLOR.drawdown}">${d.low.toFixed(1)}</b>
             <span>C</span><b>${d.close.toFixed(1)}</b>
           </div>`,
          mx,
          my + 12,
        );
      })
        .on("pointermove", function (event) {
          const [mx, my] = d3.pointer(event, containerRef.current);
          placeTooltip(mx, my + 12);
        })
        .on("pointerleave", function (_e, d) {
          const i = pts.indexOf(d);
          d3.select(this).select("rect").attr("fill-opacity", i === series.lastIndex ? 1 : 0.85);
          hideTooltip();
          onHoverDateRef.current?.(null);
        });

      return;
    }

    // ── Line / area series (everything else, incl. overlaid spot) ─────────
    // Drawdown gets an emphasised zero line for reference.
    if (active.drawdown) {
      const yd = scales.get("drawdown")!;
      root
        .append("line")
        .attr("x1", 0).attr("x2", innerW)
        .attr("y1", yd(0)).attr("y2", yd(0))
        .attr("stroke", COLOR.zero)
        .attr("stroke-width", 1);
    }

    const drawLineSeries = (k: SeriesKey) => {
      const y = scales.get(k)!;
      const accessor = SERIES_FNS[k].value;
      const color = currentSeriesMeta[k].color;

      const line = d3
        .line<DayPoint>()
        .x(cx)
        .y((d) => y(accessor(d)))
        .curve(d3.curveMonotoneX);

      // Area fill only in single-series mode (keeps overlays readable).
      if (single) {
        const gradId = `ceGrad-${k}`;
        const grad = defs
          .append("linearGradient")
          .attr("id", gradId)
          .attr("x1", "0").attr("y1", "0").attr("x2", "0").attr("y2", "1");
        if (k === "drawdown") {
          grad.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.05);
          grad.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0.4);
        } else {
          grad.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.42);
          grad.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
        }
        const area = d3
          .area<DayPoint>()
          .x(cx)
          .y0(k === "drawdown" ? y(0) : innerH)
          .y1((d) => y(accessor(d)))
          .curve(d3.curveMonotoneX);
        root
          .append("path")
          .datum(pts)
          .attr("fill", `url(#${gradId})`)
          .attr("d", area)
          .attr("opacity", 0)
          .transition().delay(170).duration(500).attr("opacity", 1);
      }

      const path = root
        .append("path")
        .datum(pts)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 2.25)
        .attr("stroke-linejoin", "round")
        .attr("d", line);
      const total = (path.node() as SVGPathElement).getTotalLength();
      path
        .attr("stroke-dasharray", `${total} ${total}`)
        .attr("stroke-dashoffset", total)
        .transition().duration(900).ease(d3.easeCubicInOut)
        .attr("stroke-dashoffset", 0);

      // End-of-line marker.
      const last = pts[series.lastIndex];
      root
        .append("circle")
        .attr("cx", cx(last))
        .attr("cy", y(accessor(last)))
        .attr("r", 0)
        .attr("fill", color)
        .attr("stroke", "rgba(0,0,0,0.4)")
        .attr("stroke-width", 1.5)
        .transition().delay(900).duration(300)
        .attr("r", single ? 5 : 4);
    };

    // Draw in a stable order so colours stack predictably.
    activeKeys.forEach(drawLineSeries);

    // Peak-drawdown callout — only when drawdown is shown on its own.
    if (single && active.drawdown) {
      const y = scales.get("drawdown")!;
      const trough = pts[series.troughIndex];
      const tx = cx(trough);
      const ty = y(trough.drawdownPct);
      const marker = root.append("g").attr("opacity", 0);
      marker.transition().delay(950).duration(350).attr("opacity", 1);
      marker
        .append("line")
        .attr("x1", tx).attr("x2", tx)
        .attr("y1", y(0)).attr("y2", ty)
        .attr("stroke", COLOR.drawdown)
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "2 3");
      marker
        .append("circle")
        .attr("cx", tx).attr("cy", ty).attr("r", 5)
        .attr("fill", COLOR.drawdown)
        .attr("stroke", "rgba(0,0,0,0.45)").attr("stroke-width", 1.5);
      const labelText = `Max DD ${trough.drawdownPct.toFixed(1)}%`;
      const labelW = labelText.length * 6.4 + 16;
      const lx = Math.min(Math.max(tx - labelW / 2, 0), innerW - labelW);
      const lg = marker.append("g").attr("transform", `translate(${lx},${ty + 14})`);
      lg.append("rect")
        .attr("width", labelW).attr("height", 22).attr("rx", 6)
        .attr("fill", "rgba(20,16,18,0.92)")
        .attr("stroke", COLOR.drawdown).attr("stroke-opacity", 0.5);
      lg.append("text")
        .attr("x", labelW / 2).attr("y", 15)
        .attr("text-anchor", "middle")
        .attr("fill", COLOR.drawdown)
        .attr("font-size", 11).attr("font-weight", 600)
        .text(labelText);
    }

    // ── Shared crosshair across all active line series ────────────────────
    bindCrosshair();

    function bindCrosshair() {
      const focus = root.append("g").attr("opacity", 0);
      const vline = focus
        .append("line")
        .attr("y1", 0).attr("y2", innerH)
        .attr("stroke", "rgba(255,255,255,0.22)")
        .attr("stroke-dasharray", "3 3");
      const dots = activeKeys.map((k) =>
        focus
          .append("circle")
          .attr("r", 4.5)
          .attr("fill", currentSeriesMeta[k].color)
          .attr("stroke", "rgba(0,0,0,0.5)")
          .attr("stroke-width", 1.5),
      );

      const positions = pts.map(cx);
      root
        .append("rect")
        .attr("width", innerW)
        .attr("height", innerH)
        .attr("fill", "transparent")
        .style("cursor", "crosshair")
        .on("pointermove", (event) => {
          const [mx] = d3.pointer(event);
          let nearest = 0;
          let best = Infinity;
          positions.forEach((p, i) => {
            const dist = Math.abs(p - mx);
            if (dist < best) {
              best = dist;
              nearest = i;
            }
          });
          const d = pts[nearest];
          focus.attr("opacity", 1);
          vline.attr("x1", cx(d)).attr("x2", cx(d));
          onHoverDateRef.current?.(d.date);

          let topY = innerH;
          activeKeys.forEach((k, idx) => {
            const yy = scales.get(k)!(SERIES_FNS[k].value(d));
            dots[idx].attr("cx", cx(d)).attr("cy", yy);
            topY = Math.min(topY, yy);
          });

          const rows = activeKeys
            .map(
              (k) =>
                `<div class="ce-tt-row"><span style="color:${currentSeriesMeta[k].color}">${currentSeriesMeta[k].label}</span><b>${SERIES_FNS[k].tipFmt(d)}</b></div>`,
            )
            .join("");
          showTooltip(
            `<div class="ce-tt-date">${fmtFullDate(parseDate(d.date)!)}</div>${rows}`,
            cx(d) + MARGIN.left,
            topY + MARGIN.top - 8,
          );
        })
        .on("pointerleave", () => {
          focus.attr("opacity", 0);
          hideTooltip();
          onHoverDateRef.current?.(null);
        });
    }
  }, [series, activeKeys, active, width]);

  const activeUnits = activeKeys.map((k) => currentSeriesMeta[k].unit).join(" · ");

  return (
    <div className="glass-surface overflow-hidden rounded-2xl p-5">
      {/* ── Top controls ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
            <Activity className="size-4" />
          </div>
          <div>
            <h3 className="font-heading text-[15px] font-semibold leading-tight">
              Charts Explorer
            </h3>
            <p className="text-xs text-muted-foreground">
              {activeUnits}
              {sample && (
                <span className="ml-2 rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sample
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Series toggle chips — overlay any combination. */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chart series">
          {SERIES_ORDER.map((k) => {
            const meta = currentSeriesMeta[k];
            const Icon = meta.icon;
            const on = active[k];
            return (
              <button
                key={k}
                type="button"
                data-testid={`series-${k}`}
                aria-pressed={on}
                onClick={() => toggle(k)}
                className={cn(
                  "flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                  on
                    ? "text-foreground"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10",
                )}
                style={
                  on
                    ? {
                        borderColor: `${meta.color}80`,
                        backgroundColor: `${meta.color}1f`,
                        color: meta.color,
                      }
                    : undefined
                }
              >
                <Icon className="size-4" />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Plot ─────────────────────────────────────────────────────── */}
      <div ref={containerRef} className="relative mt-4 w-full">
        <svg
          ref={svgRef}
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${activeKeys.map((k) => currentSeriesMeta[k].label).join(", ")} chart`}
          className="block overflow-visible"
        />
        <div
          ref={tooltipRef}
          className="ce-tooltip pointer-events-none absolute left-0 top-0 z-20 opacity-0"
        />
      </div>

      {/* Legend / footer. */}
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {activeKeys.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: currentSeriesMeta[k].color }}
              />
              {currentSeriesMeta[k].label}
            </span>
          ))}
        </span>
        <span>{series.points.length} trading days · synchronised daily axis</span>
      </div>
    </div>
  );
}
