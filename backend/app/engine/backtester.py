"""
Backtesting orchestrator: wires the data manager, strategy, executor and
performance tracker into a single chronological simulation pass.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

import pandas as pd

from .config import StrategyConfig
from .data_manager import DataManager
from .execution import ExecutionHandler
from .strategy import Strategy
from .analytics import PerformanceTracker

logger = logging.getLogger("OptionsBacktester.Backtester")

# Signature: (current_day_index, total_days) -> None
ProgressCallback = Callable[[int, int], None]


class Backtester:
    """Master orchestrator executing chronologically indexed simulation passes."""

    def __init__(
        self,
        options_path: str,
        spot_path: str,
        config: StrategyConfig,
        stock_code: str = "NIFTY",
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> None:
        self.config = config
        # Pass the range to the data layer so a partitioned (multi-year) dataset
        # only loads the expiry partitions overlapping [start_date, end_date].
        self.dm = DataManager(
            options_path, spot_path, stock_code, start_date=start_date, end_date=end_date
        )
        self.strategy = Strategy(config, self.dm)
        self.executor = ExecutionHandler(config, self.dm)
        self.tracker = PerformanceTracker(lot_size=config.lot_size)
        self.capital = config.capital

    def run(
        self,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> PerformanceTracker:
        """Run the simulation across the (optionally bounded) date range.

        Args:
            start_date: Inclusive ISO start date, or None for the dataset start.
            end_date:   Inclusive ISO end date, or None for the dataset end.
            progress_callback: Optional callback invoked once per trading day as
                ``(day_index, total_days)`` — used to report Celery progress.
        """
        trading_days = self.dm.trading_dates()

        if start_date:
            trading_days = [d for d in trading_days if d >= pd.Timestamp(start_date)]
        if end_date:
            trading_days = [d for d in trading_days if d <= pd.Timestamp(end_date)]

        total = len(trading_days)
        logger.info(
            f"Starting backtest | {total} trading days | "
            f"Strategy: {self.config.strategy_type.value}"
        )

        available_capital = self.capital

        for i, date in enumerate(trading_days, start=1):
            logger.info(f"Processing: {date.date()} ({i}/{total})")

            trade = self.strategy.build_trade(date)
            if trade is not None and self.executor.check_capital_sufficiency(
                trade, available_capital
            ):
                trade = self.executor.run_trade(trade)
                self.tracker.record_trade(trade)
                logger.info(
                    f"  Day PnL: ₹{trade.total_pnl:+,.2f} | "
                    f"Peak Margin: ₹{trade.peak_margin_deployed:,.0f} | "
                    f"Legs: {len(trade.legs)}"
                )

            if progress_callback is not None:
                progress_callback(i, total)

        logger.info(f"Backtest complete | {len(self.tracker.trades)} sessions executed.")
        return self.tracker
