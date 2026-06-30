"""
Performance analytics: aggregates executed trades into a quantitative tear
sheet, a daily equity/drawdown curve, and a JSON-serialisable trade log.
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd

from .constants import NIFTY_LOT_SIZE
from .models import LegStatus, Trade

logger = logging.getLogger("OptionsBacktester.Analytics")


def _json_safe(value: Any) -> Any:
    """Coerce numpy / pandas scalars to JSON-native types; map inf/NaN to None."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return None if (math.isinf(v) or math.isnan(v)) else v
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    return value


class PerformanceTracker:
    """Aggregates trade telemetry into reporting metrics and chart data."""

    def __init__(self, lot_size: int = NIFTY_LOT_SIZE) -> None:
        self.lot_size = lot_size
        self.trades: List[Trade] = []
        self.trade_log: pd.DataFrame = pd.DataFrame()

    def record_trade(self, trade: Trade) -> None:
        """Append a completed trade for later aggregation."""
        self.trades.append(trade)

    def build_trade_log(self) -> pd.DataFrame:
        """Flatten all non-open legs into a tabular trade log."""
        records = []
        for trade in self.trades:
            for leg in trade.legs:
                if leg.status == LegStatus.OPEN:
                    continue
                records.append(
                    {
                        "trade_id": trade.trade_id,
                        "strategy": trade.strategy_type
                        if isinstance(trade.strategy_type, str)
                        else getattr(trade.strategy_type, "value", str(trade.strategy_type)),
                        "date": trade.date.date(),
                        "leg_id": leg.leg_id,
                        "right": leg.right.value,
                        "strike": leg.strike,
                        "direction": leg.direction,
                        "expiry": pd.Timestamp(leg.expiry).date(),
                        "entry_time": leg.entry_time,
                        "exit_time": leg.exit_time,
                        "entry_premium": round(leg.entry_premium, 2),
                        "exit_premium": round(leg.exit_premium, 2),
                        "premium_change": round(leg.exit_premium - leg.entry_premium, 2),
                        "lots": leg.num_lots,
                        "lot_size": leg.lot_size,
                        "margin_blocked": round(leg.margin_blocked, 0),
                        # Trade-level peak *concurrent* margin (same value on every
                        # leg of the trade); aggregated with max, never summed, so
                        # recycled re-entry capital is not double-counted.
                        "trade_peak_margin": round(trade.peak_margin_deployed, 0),
                        "net_pnl_inr": round(leg.net_pnl, 2),
                        "exit_reason": leg.exit_reason,
                    }
                )
        self.trade_log = pd.DataFrame(records)
        return self.trade_log

    def compute_daily_pnl(self) -> pd.Series:
        """Net PnL summed per trading date."""
        if self.trade_log.empty:
            return pd.Series(dtype=float)
        return self.trade_log.groupby("date")["net_pnl_inr"].sum()

    def max_drawdown(
        self, daily_pnl: pd.Series, initial_capital: float
    ) -> Tuple[float, float]:
        """Maximum drawdown of a daily-PnL series in INR and as % of initial capital.

        The drawdown amount is the deepest drop below the running peak **equity**
        (initial_capital + cumulative PnL); the percentage is taken against the
        **initial capital** denominator. This matches the running-drawdown series
        in ``build_equity_curve`` so the headline card and the drawdown chart
        agree. (initial_capital > 0, so there is no divide-by-zero.)
        """
        equity = initial_capital + daily_pnl.cumsum()
        # Seed the running peak with initial_capital (matches build_equity_curve,
        # whose peak starts at capital before day one) so card == chart exactly.
        peak = equity.cummax().clip(lower=initial_capital)
        drawdown = equity - peak
        mdd_inr = drawdown.min()
        mdd_pct = (drawdown / initial_capital).min() * 100
        return mdd_inr, mdd_pct

    # ── Tear sheet ──────────────────────────────────────────────────────────
    def generate_tear_sheet(
        self, initial_capital: float = 1_000_000.0, verbose: bool = False
    ) -> Dict[str, Any]:
        """Compute the full quantitative tear sheet (original label set)."""
        if not self.trades:
            logger.warning("No trades to analyse.")
            return {}

        log = self.build_trade_log()
        if log.empty:
            logger.warning("Trade log is empty.")
            return {}

        trade_summary = (
            log.groupby("trade_id")
            .agg(
                date=("date", "first"),
                net_pnl_inr=("net_pnl_inr", "sum"),
                # Peak concurrent margin per day = max of the per-trade peak (one
                # value per trade), NOT the sum of every leg's blocked margin.
                # Summing stacked re-entries inflated this to ~32L; the live
                # tracker caps it at the daily ceiling.
                total_margin=("trade_peak_margin", "max"),
            )
            .reset_index()
        )

        total_days = len(trade_summary)
        winning_days = int((trade_summary["net_pnl_inr"] > 0).sum())
        losing_days = int((trade_summary["net_pnl_inr"] <= 0).sum())
        daily_win_rate = winning_days / total_days * 100 if total_days else 0

        total_executions = len(log)
        winning_executions = int((log["net_pnl_inr"] > 0).sum())
        losing_executions = int((log["net_pnl_inr"] <= 0).sum())
        execution_win_rate = (
            (winning_executions / total_executions * 100) if total_executions else 0
        )

        gross_profit = log[log["net_pnl_inr"] > 0]["net_pnl_inr"].sum()
        gross_loss = abs(log[log["net_pnl_inr"] <= 0]["net_pnl_inr"].sum())
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

        total_net_pnl = trade_summary["net_pnl_inr"].sum()
        avg_daily_pnl = trade_summary["net_pnl_inr"].mean()
        max_daily_pnl = trade_summary["net_pnl_inr"].max()
        min_daily_pnl = trade_summary["net_pnl_inr"].min()

        total_pnl_points = total_net_pnl / self.lot_size
        peak_margin = trade_summary["total_margin"].max()
        rom_pct = (total_net_pnl / peak_margin * 100) if peak_margin > 0 else 0
        roc_pct = total_net_pnl / initial_capital * 100

        daily_pnl = self.compute_daily_pnl()
        mdd_inr, mdd_pct = self.max_drawdown(daily_pnl, initial_capital)
        mdd_points = mdd_inr / self.lot_size

        sl_hits = log[log["exit_reason"].str.contains("Stop Loss Hit", na=False)]
        sl_count = len(sl_hits)

        if len(daily_pnl) > 1:
            daily_ret = daily_pnl / initial_capital
            sharpe = (daily_ret.mean() / daily_ret.std()) * np.sqrt(252)
        else:
            sharpe = 0.0

        metrics = {
            "Total Trading Days": total_days,
            "Winning Days": winning_days,
            "Losing Days": losing_days,
            "Daily Win Rate (%)": round(daily_win_rate, 2),
            "Total Individual Trades": total_executions,
            "Winning Trades": winning_executions,
            "Losing Trades": losing_executions,
            "Trade Win Rate (%)": round(execution_win_rate, 2),
            "Profit Factor": round(profit_factor, 2),
            "Total Net PnL (₹)": round(total_net_pnl, 2),
            "Total Net PnL (Points)": round(total_pnl_points, 2),
            "Avg Daily PnL (₹)": round(avg_daily_pnl, 2),
            "Best Day (₹)": round(max_daily_pnl, 2),
            "Worst Day (₹)": round(min_daily_pnl, 2),
            "Return on Margin (%)": round(rom_pct, 2),
            "Return on Capital (%)": round(roc_pct, 2),
            "Peak Margin Deployed (₹)": round(peak_margin, 0),
            "Max Drawdown (₹)": round(mdd_inr, 2),
            "Max Drawdown (Points)": round(mdd_points, 2),
            "Max Drawdown (%)": round(mdd_pct, 2),
            "Stop Losses Hit (Total)": sl_count,
            "Sharpe Ratio (Daily)": round(sharpe, 3),
            "Initial Capital (₹)": initial_capital,
        }

        if verbose:
            self._print_tear_sheet(metrics)
        return {k: _json_safe(v) for k, v in metrics.items()}

    @staticmethod
    def _print_tear_sheet(metrics: Dict[str, Any]) -> None:
        sep = "=" * 65
        print(f"\n{sep}")
        print("  QUANTITATIVE PERFORMANCE TEAR SHEET")
        print(sep)
        for k, v in metrics.items():
            if isinstance(v, float):
                print(f"  {k:<35} {v:>12,.2f}")
            else:
                print(f"  {k:<35} {v:>12}")
        print(f"\n{sep}\n")

    # ── Chart / API payloads ────────────────────────────────────────────────
    def build_equity_curve(self, initial_capital: float) -> List[Dict[str, Any]]:
        """Daily equity curve with running drawdown, ready for charting.

        Each point: date, daily pnl, cumulative pnl, equity, drawdown (INR),
        drawdown_pct (against initial capital).
        """
        daily_pnl = self.compute_daily_pnl()
        points: List[Dict[str, Any]] = []
        cumulative = 0.0
        peak = initial_capital
        for date, pnl in daily_pnl.items():
            pnl = float(pnl)
            cumulative += pnl
            equity = initial_capital + cumulative
            peak = max(peak, equity)
            drawdown = equity - peak
            drawdown_pct = (drawdown / initial_capital * 100) if initial_capital else 0.0
            points.append(
                {
                    "date": pd.Timestamp(date).strftime("%Y-%m-%d"),
                    "pnl": round(pnl, 2),
                    "cumulative_pnl": round(cumulative, 2),
                    "equity": round(equity, 2),
                    "drawdown": round(drawdown, 2),
                    "drawdown_pct": round(drawdown_pct, 2),
                }
            )
        return points

    def build_trade_log_records(self) -> List[Dict[str, Any]]:
        """JSON-serialisable list of trade-log rows (dates/times as ISO strings)."""
        log = self.trade_log if not self.trade_log.empty else self.build_trade_log()
        if log.empty:
            return []

        records: List[Dict[str, Any]] = []
        for _, row in log.iterrows():
            records.append(
                {
                    "trade_id": int(row["trade_id"]),
                    "strategy": str(row["strategy"]),
                    "date": pd.Timestamp(row["date"]).strftime("%Y-%m-%d"),
                    "leg_id": str(row["leg_id"]),
                    "right": str(row["right"]),
                    "strike": float(row["strike"]),
                    "direction": str(row["direction"]),
                    "expiry": pd.Timestamp(row["expiry"]).strftime("%Y-%m-%d"),
                    "entry_time": pd.Timestamp(row["entry_time"]).isoformat()
                    if pd.notna(row["entry_time"])
                    else None,
                    "exit_time": pd.Timestamp(row["exit_time"]).isoformat()
                    if pd.notna(row["exit_time"])
                    else None,
                    "entry_premium": float(row["entry_premium"]),
                    "exit_premium": float(row["exit_premium"]),
                    "premium_change": float(row["premium_change"]),
                    "lots": int(row["lots"]),
                    "lot_size": int(row["lot_size"]),
                    "margin_blocked": float(row["margin_blocked"]),
                    "net_pnl_inr": float(row["net_pnl_inr"]),
                    "exit_reason": str(row["exit_reason"]),
                }
            )
        return records

    def build_summary(self, initial_capital: float, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """Compact, clean-keyed summary for the dashboard's headline cards."""
        equity = self.build_equity_curve(initial_capital)
        final_equity = equity[-1]["equity"] if equity else initial_capital
        return {
            "total_pnl": metrics.get("Total Net PnL (₹)", 0.0),
            "total_pnl_points": metrics.get("Total Net PnL (Points)", 0.0),
            "max_drawdown_inr": metrics.get("Max Drawdown (₹)", 0.0),
            "max_drawdown_pct": metrics.get("Max Drawdown (%)", 0.0),
            "trade_win_rate": metrics.get("Trade Win Rate (%)", 0.0),
            "daily_win_rate": metrics.get("Daily Win Rate (%)", 0.0),
            "sharpe": metrics.get("Sharpe Ratio (Daily)", 0.0),
            "profit_factor": metrics.get("Profit Factor"),
            "total_trades": metrics.get("Total Individual Trades", 0),
            "total_days": metrics.get("Total Trading Days", 0),
            "return_on_capital_pct": metrics.get("Return on Capital (%)", 0.0),
            "initial_capital": initial_capital,
            "final_equity": round(final_equity, 2),
        }

    def build_results(self, initial_capital: float) -> Dict[str, Any]:
        """Assemble the complete results payload returned by the API."""
        metrics = self.generate_tear_sheet(initial_capital=initial_capital, verbose=False)
        return {
            "metrics": metrics,
            "summary": self.build_summary(initial_capital, metrics) if metrics else {},
            "equity_curve": self.build_equity_curve(initial_capital),
            "trade_log": self.build_trade_log_records(),
        }
