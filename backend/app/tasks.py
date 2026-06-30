"""Celery task that runs a backtest asynchronously and stores the results."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

import pandas as pd
from celery import Task

from . import db
from .celery_app import celery
from .config import settings
from .engine.backtester import Backtester
from .engine.config import StrategyConfig
from .engine.data_manager import DataManager
from .engine.greeks import build_greeks_timeseries

logger = logging.getLogger("OptionsBacktester.Task")


def _build_benchmark(
    dm: DataManager, equity_curve: List[Dict[str, Any]], capital: float
) -> List[Dict[str, Any]]:
    """Nifty buy-and-hold equity over the equity-curve dates, scaled to ``capital``.

    Lets the UI compare the strategy against simply holding the index. Uses each
    day's last spot close, carried forward when a date has no bar.
    """
    if not equity_curve or dm.spot_df.empty:
        return []
    daily_close = dm.spot_df.groupby(dm.spot_df["datetime"].dt.normalize())["close"].last()
    out: List[Dict[str, Any]] = []
    base: float | None = None
    for point in equity_curve:
        day = pd.Timestamp(point["date"]).normalize()
        close = daily_close.get(day)
        if close is None:
            prior = daily_close[daily_close.index <= day]
            if prior.empty:
                continue
            close = float(prior.iloc[-1])
        if base is None:
            base = float(close)
        out.append({"date": point["date"], "equity": round(capital * float(close) / base, 2)})
    return out


@celery.task(bind=True, name="app.tasks.run_backtest")
def run_backtest(self: Task, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a backtest from a serialised request payload.

    Args:
        payload: JSON dict with keys ``config`` (StrategyConfig fields),
            ``start_date``, ``end_date`` and ``dataset``.

    Returns:
        The full results dict (metrics, summary, equity_curve, trade_log).

    Raises:
        FileNotFoundError: when the dataset's Parquet files are missing.
    """
    config = StrategyConfig(**payload.get("config", {}))
    dataset = payload.get("dataset", "nifty")
    start_date = payload.get("start_date")
    end_date = payload.get("end_date")

    options_path, spot_path = settings.dataset_paths(dataset)
    if not options_path.exists() or not spot_path.exists():
        raise FileNotFoundError(
            f"Dataset '{dataset}' not found. Expected {options_path.name} and "
            f"{spot_path.name} in {settings.data_dir}. Run the Parquet converter first."
        )

    self.update_state(state="PROGRESS", meta={"current": 0, "total": 0, "percent": 0.0})

    backtester = Backtester(
        options_path=str(options_path),
        spot_path=str(spot_path),
        config=config,
        stock_code=settings.stock_code,
        start_date=start_date,
        end_date=end_date,
    )

    def on_progress(current: int, total: int) -> None:
        """Relay simulation progress to Celery state for the status endpoint."""
        percent = round(current / total * 100, 1) if total else 0.0
        self.update_state(
            state="PROGRESS", meta={"current": current, "total": total, "percent": percent}
        )

    tracker = backtester.run(
        start_date=start_date, end_date=end_date, progress_callback=on_progress
    )
    results = tracker.build_results(initial_capital=config.capital)
    results["benchmark"] = _build_benchmark(
        backtester.dm, results.get("equity_curve", []), config.capital
    )
    # Daily portfolio risk profile (Delta/Gamma/Theta/Vega), with IV implied
    # from each leg's traded entry premium against the run's spot feed.
    results["greeks"] = build_greeks_timeseries(
        tracker.trades, backtester.dm.get_spot_price, rate=config.risk_free_rate
    )
    results["symbol"] = dataset.upper()

    # Persist the completed run to the history DB (best-effort).
    try:
        db.init_db()
        db.save_run(self.request.id, payload, results)
    except Exception:
        logger.exception("Failed to persist run to history DB.")

    return results
