/**
 * Typed client for the FastAPI backtest API.
 *
 * Mirrors the Pydantic schemas in `backend/app/schemas.py`. The base URL is
 * read from `NEXT_PUBLIC_API_BASE_URL` (falls back to the local dev server).
 */

// Empty by default → calls are same-origin (`/api/...`) and the Next server
// proxies them to the backend (see `rewrites` in next.config.ts). This keeps
// the browser talking to a single origin, so one tunnel/host serves the whole
// app with no CORS setup. Override with NEXT_PUBLIC_API_BASE_URL to hit a
// backend directly.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

// Calendar bounds of the multi-year dataset (Jan 2023 – Feb 2026). Used to
// constrain the date pickers so users can't select out-of-range days.
export const DATA_MIN_DATE = "2023-01-01";
export const DATA_MAX_DATE = "2026-02-28";

/** Run mode selecting which strategies execute. */
export type RunMode = "WALL_ONLY" | "ORB_ONLY" | "COMBINED";

/** Strategy parameters sent to the engine (mirrors engine StrategyConfig). */
export interface StrategyConfigInput {
  run_mode: RunMode;
  strategy_type: string;
  // Per-strategy enable switches (take precedence over run_mode on the backend).
  wall_enabled: boolean;
  orb_enabled: boolean;
  straddle_enabled: boolean;
  entry_time: string;
  exit_time: string;
  expiry_selection: string;
  orb_minutes: number;
  orb_cutoff_time: string;
  iv_drop_threshold: number;
  required_anomalies: number;
  capital: number;
  lot_size: number;
  strike_step: number;
  max_reentries: number;
  // Per-strategy exit rules. Wall Reversion and ORB each carry their own
  // stop-loss / trailing-stop / max-hold / take-profit (fractions, bars).
  wall_stop_loss_pct: number;
  wall_trailing_sl_pct: number;
  wall_max_hold_bars: number;
  wall_take_profit_pct: number;
  orb_stop_loss_pct: number;
  orb_trailing_sl_pct: number;
  orb_max_hold_bars: number;
  orb_take_profit_pct: number;
  orb_max_reentries: number;
  // Short Straddle exit rules (fixed breakeven-shift logic lives in the engine).
  straddle_entry_time: string;
  straddle_exit_time: string;
  straddle_stop_loss_pct: number;
  // Advanced Wall Reversion tuning ("More settings").
  iv_scan_depth: number;
  ema_period: number;
  cooldown_minutes: number;
  capital_deploy_pct: number;
  // Legacy shared exit fields (optional; superseded by the per-strategy ones).
  stop_loss_pct?: number;
  trailing_sl_pct?: number;
  max_hold_bars?: number;
  take_profit_pct?: number;
}

/** Body for POST /api/backtest/start. */
export interface BacktestRequest {
  config: StrategyConfigInput;
  start_date: string | null;
  end_date: string | null;
  dataset: string;
}

export interface StartResponse {
  task_id: string;
  status: string;
}

export interface ProgressInfo {
  current: number;
  total: number;
  percent: number;
}

export type TaskState =
  | "PENDING"
  | "STARTED"
  | "PROGRESS"
  | "SUCCESS"
  | "FAILURE"
  | "RETRY"
  | "REVOKED";

export interface StatusResponse {
  task_id: string;
  status: TaskState;
  progress: ProgressInfo | null;
  error: string | null;
}

export interface EquityPoint {
  date: string;
  pnl: number;
  cumulative_pnl: number;
  equity: number;
  drawdown: number;
  drawdown_pct: number;
}

export interface TradeLogRow {
  trade_id: number;
  strategy: string;
  date: string;
  leg_id: string;
  right: string;
  strike: number;
  direction: string;
  expiry: string;
  entry_time: string | null;
  exit_time: string | null;
  entry_premium: number;
  exit_premium: number;
  premium_change: number;
  lots: number;
  lot_size: number;
  margin_blocked: number;
  net_pnl_inr: number;
  exit_reason: string;
}

export interface BacktestSummary {
  total_pnl: number;
  total_pnl_points: number;
  max_drawdown_inr: number;
  max_drawdown_pct: number;
  trade_win_rate: number;
  daily_win_rate: number;
  sharpe: number;
  profit_factor: number | null;
  total_trades: number;
  total_days: number;
  return_on_capital_pct: number;
  initial_capital: number;
  final_equity: number;
}

export interface BenchmarkPoint {
  date: string;
  equity: number;
}

/** Aggregate portfolio Greeks (and the underlying ref) for one trading day. */
export interface GreeksPoint {
  date: string;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  spot: number;
}

export interface ResultsResponse {
  task_id: string;
  status: string;
  symbol: string;
  metrics: Record<string, number | string | null>;
  summary: BacktestSummary;
  equity_curve: EquityPoint[];
  trade_log: TradeLogRow[];
  benchmark?: BenchmarkPoint[];
  greeks?: GreeksPoint[];
}

/** A persisted backtest's metadata (history list row). */
export interface RunSummary {
  id: string;
  created_at: string;
  label: string;
  dataset: string;
  start_date: string | null;
  end_date: string | null;
  run_mode: string | null;
  /** Human-readable strategy label (e.g. "Short Straddle"). Older runs may be null. */
  strategy_type: string | null;
  total_pnl: number | null;
  total_trades: number | null;
  total_days: number | null;
}

/** A full persisted run (metadata + stored config + results payload). */
export interface StoredRun extends RunSummary {
  config: StrategyConfigInput;
  results: ResultsResponse;
}

export interface ConfigPreset {
  id: string;
  name: string;
  created_at: string;
  config: StrategyConfigInput;
}

/** Parse a JSON error body from FastAPI into a readable message. */
async function toError(res: Response): Promise<Error> {
  let detail = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") {
      detail = body.detail;
    } else if (Array.isArray(body?.detail)) {
      // FastAPI-style validation error array: [{ loc, msg }, ...]
      detail = body.detail
        .map((e: { loc?: unknown[]; msg?: string }) => {
          const loc = (e.loc ?? []).filter((p) => p !== "body").join(" → ");
          return loc ? `${loc}: ${e.msg}` : e.msg;
        })
        .join("; ");
    }
  } catch {
    /* non-JSON error body — keep the default message */
  }
  return new Error(detail);
}

/** GET the list of available dataset names. */
export async function fetchDatasets(): Promise<string[]> {
  const res = await fetch(`${API_BASE_URL}/api/datasets`, { cache: "no-store" });
  if (!res.ok) throw await toError(res);
  const data = (await res.json()) as { datasets: string[] };
  return data.datasets;
}

/**
 * GET the expiries available for a dataset, optionally bounded by a date range.
 *
 * When `start`/`end` are supplied the backend returns the contiguous block of
 * monthly expiries the engine could trade over that range — exactly what the
 * "Target Expiry" dropdown should offer. Returns `[]` for single-file datasets.
 */
export async function fetchDatasetExpiries(
  dataset: string,
  start?: string | null,
  end?: string | null,
): Promise<string[]> {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const qs = params.toString();
  const res = await fetch(
    `${API_BASE_URL}/api/datasets/${encodeURIComponent(dataset)}/expiries${qs ? `?${qs}` : ""}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw await toError(res);
  const data = (await res.json()) as { expiries: string[] };
  return data.expiries;
}

/** POST a backtest request and return the enqueued task id. */
export async function startBacktest(
  request: BacktestRequest,
): Promise<StartResponse> {
  const res = await fetch(`${API_BASE_URL}/api/backtest/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** GET the current status / progress of a task. */
export async function getBacktestStatus(
  taskId: string,
): Promise<StatusResponse> {
  const res = await fetch(`${API_BASE_URL}/api/backtest/status/${taskId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** GET the completed results of a task. */
export async function getBacktestResults(
  taskId: string,
): Promise<ResultsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/backtest/results/${taskId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** GET just the daily portfolio Greeks time-series for a completed task. */
export async function getBacktestGreeks(taskId: string): Promise<GreeksPoint[]> {
  const res = await fetch(`${API_BASE_URL}/api/backtest/greeks/${taskId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { greeks: GreeksPoint[] }).greeks;
}

// ── History ─────────────────────────────────────────────────────────────────
/** List persisted runs (most recent first). */
export async function fetchHistory(): Promise<RunSummary[]> {
  const res = await fetch(`${API_BASE_URL}/api/history`, { cache: "no-store" });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { runs: RunSummary[] }).runs;
}

/** Fetch one stored run with its full config + results. */
export async function fetchRun(runId: string): Promise<StoredRun> {
  const res = await fetch(`${API_BASE_URL}/api/history/${runId}`, { cache: "no-store" });
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** Delete a stored run. */
export async function deleteRun(runId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/history/${runId}`, { method: "DELETE" });
  if (!res.ok) throw await toError(res);
}

// ── Config presets ───────────────────────────────────────────────────────────
/** List saved config presets. */
export async function fetchPresets(): Promise<ConfigPreset[]> {
  const res = await fetch(`${API_BASE_URL}/api/presets`, { cache: "no-store" });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { presets: ConfigPreset[] }).presets;
}

/** Save (or overwrite by name) a config preset. */
export async function savePreset(
  name: string,
  config: StrategyConfigInput,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/presets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
  if (!res.ok) throw await toError(res);
}

/** Delete a saved preset. */
export async function deletePreset(presetId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/presets/${presetId}`, { method: "DELETE" });
  if (!res.ok) throw await toError(res);
}
