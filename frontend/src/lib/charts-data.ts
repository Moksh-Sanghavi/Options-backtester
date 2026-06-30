/**
 * Synthetic-but-consistent time-series generator for the Charts Explorer.
 *
 * Everything is derived from three backtest anchors (initial capital, total
 * PnL, max drawdown ₹) so the three views — equity, drawdown %, and the spot
 * candlesticks — share ONE daily time axis and tell ONE coherent story:
 *
 *   • Equity starts at `initialCapital` and ends at `initialCapital + totalPnl`.
 *   • The largest peak-to-trough swing equals exactly `maxDrawdown` (₹), so the
 *     drawdown series bottoms out at −maxDrawdown/initialCapital · 100 %.
 *   • Spot prices trend up over the window (consistent with a strongly positive
 *     strategy) and dip in sympathy with the equity drawdown.
 *
 * The output is fully deterministic (seeded PRNG) so re-renders are stable.
 */

export interface ChartAnchors {
  initialCapital: number;
  totalPnl: number;
  /** Peak-to-trough drawdown in ₹ (positive number). */
  maxDrawdown: number;
}

export interface DayPoint {
  /** ISO date, yyyy-mm-dd. */
  date: string;
  /** Cumulative account equity (₹). */
  equity: number;
  /** Drawdown from running peak, in ₹ (≤ 0). */
  drawdownInr: number;
  /** Drawdown as % of initial capital (≤ 0). */
  drawdownPct: number;
  /** Spot OHLC for the underlying. */
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartSeries {
  points: DayPoint[];
  /** Index of the deepest drawdown day (for the peak marker). */
  troughIndex: number;
  /** Index of the final day (for the distinct last candle). */
  lastIndex: number;
}

/** Mulberry32 — tiny, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** N consecutive business days (Mon–Fri) starting at `start`. */
function businessDays(start: Date, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Normalised equity shape over `n` points: rises to a peak, sells off into a
 * controlled trough, then recovers to 1.0. The peak→trough gap is exactly
 * `dip` (in normalised units) so the resulting ₹ drawdown is exact.
 */
function equityShape(n: number, dip: number): { shape: number[]; trough: number } {
  const peakIdx = Math.round((n - 1) * 0.44); // ~day 8 of 19
  const troughIdx = Math.round((n - 1) * 0.61); // ~day 11 of 19
  const peak = 0.82;
  const trough = Math.max(0.04, peak - dip);

  const shape = new Array<number>(n);

  // Leg 1 — accumulate from 0 → peak with mild easing.
  for (let i = 0; i <= peakIdx; i++) {
    const t = i / peakIdx;
    shape[i] = peak * (1 - Math.pow(1 - t, 1.7));
  }
  // Leg 2 — sell-off from peak → trough.
  shape[peakIdx + 1] = peak - dip * 0.5;
  for (let i = peakIdx + 2; i < troughIdx; i++) {
    shape[i] = peak - dip * 0.82;
  }
  shape[troughIdx] = trough;
  // Leg 3 — recovery from trough → 1.0 with easing.
  const recoverN = n - 1 - troughIdx;
  for (let k = 1; k <= recoverN; k++) {
    const t = k / recoverN;
    shape[troughIdx + k] = trough + (1 - trough) * (1 - Math.pow(1 - t, 1.9));
  }
  shape[n - 1] = 1;
  return { shape, trough };
}

/**
 * Build the unified series. Optionally seed from a real equity curve; when
 * absent we synthesise a 19-day window from the anchors alone.
 */
export function generateChartSeries(
  anchors: ChartAnchors,
  opts: {
    days?: number;
    startDate?: string;
    realDates?: string[];
    realEquity?: number[];
  } = {},
): ChartSeries {
  const { initialCapital, totalPnl, maxDrawdown } = anchors;
  const useReal = !!(opts.realDates?.length && opts.realEquity?.length);
  const n = useReal ? opts.realDates!.length : opts.days ?? 19;

  const dates = useReal
    ? opts.realDates!
    : businessDays(new Date(opts.startDate ?? "2023-12-01T00:00:00Z"), n);

  // Equity values — real if provided, else synthesised from the anchors.
  const dip = totalPnl > 0 ? Math.min(0.85, maxDrawdown / totalPnl) : 0.2;
  const { shape } = equityShape(n, dip);
  const equity = useReal
    ? opts.realEquity!.slice(0, n)
    : shape.map((s) => initialCapital + totalPnl * s);

  const rand = mulberry32(0x9e3779b1 ^ Math.round(totalPnl));

  // Spot path: starts ~20,200, trends up ~6% across the window, dipping in
  // sympathy with the equity shape; small per-day noise for realistic wicks.
  const spotBase = 20200;
  const spotRange = spotBase * 0.062;
  let prevClose = spotBase;

  // Running peak for drawdown. Seed at initial capital so a decline from the
  // very first day is measured against the starting value — this matches the
  // backend's max_drawdown (peak floored at initial_capital), so the chart's
  // "Max DD %" callout equals the headline card.
  let peakEquity = initialCapital;
  let troughIndex = 0;
  let deepestPct = 0;

  const points: DayPoint[] = dates.map((date, i) => {
    peakEquity = Math.max(peakEquity, equity[i]);
    const drawdownInr = equity[i] - peakEquity;
    // Percent against *initial capital* — (drawdown / initialCapital) × 100 —
    // NOT the running peak. This matches the backend's max-drawdown-% definition
    // (analytics.py: `(drawdown / initial_capital).min() * 100`) so the chart's
    // "Max DD %" callout/tooltip equals the headline card. Dividing by the
    // running peak instead understates the % whenever equity has grown above
    // the starting capital.
    const drawdownPct = (drawdownInr / initialCapital) * 100;
    if (drawdownPct < deepestPct) {
      deepestPct = drawdownPct;
      troughIndex = i;
    }

    // --- spot candle ---
    const trend = spotBase + spotRange * shape[i];
    const noise = (rand() - 0.5) * spotBase * 0.006;
    const close = i === 0 ? spotBase : trend + noise;
    const gap = (rand() - 0.45) * spotBase * 0.0025;
    const open = i === 0 ? spotBase - spotBase * 0.0015 : prevClose + gap;
    const bodyHi = Math.max(open, close);
    const bodyLo = Math.min(open, close);
    const high = bodyHi + rand() * spotBase * 0.0045;
    const low = bodyLo - rand() * spotBase * 0.0045;
    prevClose = close;

    return {
      date,
      equity: equity[i],
      drawdownInr,
      drawdownPct,
      open,
      high,
      low,
      close,
    };
  });

  return { points, troughIndex, lastIndex: n - 1 };
}

/** Default anchors taken from the reference backtest result. */
export const DEFAULT_ANCHORS: ChartAnchors = {
  initialCapital: 1_000_000,
  totalPnl: 689_536,
  maxDrawdown: 171_000,
};
