"""
Execution handler: the intraday event loop that walks each leg's bars, manages
trailing stops, time-based exits, and end-of-day square-off.
"""
from __future__ import annotations

import logging
from datetime import time
from typing import Dict, List, Optional

import pandas as pd

from .config import StrategyConfig
from .constants import LegStatus
from .costs import compute_transaction_cost
from .data_manager import DataManager
from .models import Trade, TradeLeg

logger = logging.getLogger("OptionsBacktester.Execution")


class ExecutionHandler:
    """Intraday event loop verifying execution compliance and protective stops."""

    def __init__(self, config: StrategyConfig, data_manager: DataManager) -> None:
        self.config = config
        self.dm = data_manager
        # Live intraday margin accounting (reset per ``run_trade``). The daily
        # margin ceiling is the hard cap on *concurrent* capital deployed; margin
        # is reserved on entry and released on exit so capital is recycled across
        # re-entries instead of being stacked.
        self._margin_ceiling = self.config.capital * self.config.capital_deploy_pct
        self._deployed_margin = 0.0
        self._peak_margin = 0.0
        self._cumulative_pnl = 0.0
        logger.info(
            f"ExecutionHandler initialised. Daily margin ceiling: "
            f"₹{self._margin_ceiling:,.0f}"
        )

    def _reserve_margin(self, leg: TradeLeg) -> bool:
        """Reserve ``leg.margin_blocked`` against the daily ceiling.

        Returns False (and reserves nothing) when admitting the leg would push
        concurrent deployed margin above the hard cap — the caller must then
        block the entry. On success the deployed total and the running peak are
        updated.
        """
        if self._deployed_margin + leg.margin_blocked > self._margin_ceiling + 1e-6:
            return False
        self._deployed_margin += leg.margin_blocked
        if self._deployed_margin > self._peak_margin:
            self._peak_margin = self._deployed_margin
        return True

    def _release_margin(self, leg: TradeLeg) -> None:
        """Return a closed leg's reserved margin to the available pool."""
        self._deployed_margin = max(0.0, self._deployed_margin - leg.margin_blocked)

    def _remaining_budget(self) -> float:
        """Budget available for the next re-entry: ceiling reduced by cumulative losses."""
        return max(0.0, min(self._margin_ceiling, self._margin_ceiling + self._cumulative_pnl))

    def run_trade(self, trade: Trade) -> Trade:
        """Simulate the full intraday lifecycle of every leg in ``trade``."""
        exit_h, exit_m = map(int, self.config.exit_time.split(":"))
        date = trade.date

        # Seed the live tracker with the initial legs the strategy already
        # admitted under the ceiling. These are OPEN from the first bar.
        self._deployed_margin = sum(
            leg.margin_blocked for leg in trade.legs if leg.status == LegStatus.OPEN
        )
        self._peak_margin = self._deployed_margin

        leg_ts: Dict[str, pd.DataFrame] = {}
        for leg in trade.legs:
            ts = self.dm.get_option_timeseries(
                date=date,
                expiry_date=leg.expiry,
                right=leg.right.value,
                strike=leg.strike,
            )
            if not ts.empty:
                leg_ts[leg.leg_id] = ts.set_index("datetime").sort_index()

        all_timestamps = sorted(set().union(*[df.index.tolist() for df in leg_ts.values()])) if leg_ts else []

        pending_reentries: List[TradeLeg] = []

        for ts in all_timestamps:
            current_time = ts.time()

            if current_time >= time(exit_h, exit_m):
                self._close_all_legs(trade, ts, leg_ts, reason="Exit Time")
                break

            for leg in trade.legs:
                if leg.status != LegStatus.OPEN or leg.leg_id not in leg_ts:
                    continue

                ts_df = leg_ts[leg.leg_id]
                if ts not in ts_df.index:
                    continue

                if ts < leg.entry_time:
                    continue

                bar_high = float(ts_df.loc[ts, "high"])
                bar_low = float(ts_df.loc[ts, "low"])
                bar_close = float(ts_df.loc[ts, "close"])

                if bar_close <= 0:
                    continue

                # Per-leg square-off (e.g. Short Straddle at 14:45), independent
                # of the global exit time.
                if leg.square_off_time is not None and ts >= leg.square_off_time:
                    self._close_leg(leg, ts, bar_close, reason="Square-Off")
                    continue

                leg.bars_held += 1

                if leg.bars_held >= leg.max_hold_bars:
                    self._close_leg(leg, ts, bar_close, reason="Time Decay Force Exit")
                    continue

                if leg.direction == "BUY":
                    leg.update_trailing_stop(bar_high)

                    if leg.is_stop_triggered(bar_low):
                        fill_price = max(bar_low, leg.stop_loss_level * 0.99)
                        if leg.stop_loss_level > leg.entry_premium:
                            sl_reason = "Trailing Stop (Profit)"
                        else:
                            sl_reason = "Long Stop Loss Hit"
                        self._close_leg(leg, ts, fill_price, reason=sl_reason)
                        if leg.strategy_label == "ORB":
                            # Dynamic re-entry: re-arm on the opening range and take
                            # the next fresh breakout (a freshly-priced ATM contract).
                            reentry = self._next_orb_reentry(trade, ts)
                            if reentry is not None:
                                pending_reentries.append(reentry)
                        elif leg.strategy_label == "Wall Reversion":
                            # Dynamic re-entry: wait for the next fresh IV anomaly
                            # signal, sized on the remaining day budget after losses.
                            reentry = self._next_wall_reentry(trade, ts, leg.right)
                            if reentry is not None:
                                pending_reentries.append(reentry)
                        continue

                    # Take-profit (disabled when the target sits sky-high, i.e. tp=0).
                    if bar_high >= leg.take_profit_level:
                        self._close_leg(leg, ts, leg.take_profit_level, reason="Take Profit")
                        continue

                else:  # SELL — short-premium legs (e.g. Short Straddle)
                    # A short is hurt when premium rises, so the stop is breached
                    # on the bar high. No trailing: the stop is fixed until a
                    # sibling stops out and shifts this leg's stop to breakeven.
                    if leg.is_stop_triggered(bar_high):
                        fill_price = min(bar_high, leg.stop_loss_level * 1.01)
                        if leg.stop_loss_level <= leg.entry_premium:
                            sl_reason = "Breakeven Stop"
                        else:
                            sl_reason = "Short Stop Loss Hit"
                        self._close_leg(leg, ts, fill_price, reason=sl_reason)
                        self._shift_sibling_stops_to_breakeven(trade, leg)
                        continue

            # Activate any queued re-entries so later bars can manage them. Each
            # must fit under the daily margin ceiling using only capital freed by
            # the stop-out that triggered it; if it doesn't, the re-entry is
            # blocked (no fresh capital is allocated beyond the hard cap).
            if pending_reentries:
                for new_leg in pending_reentries:
                    if not self._reserve_margin(new_leg):
                        logger.warning(
                            f"  Re-entry {new_leg.leg_id} BLOCKED: margin "
                            f"₹{new_leg.margin_blocked:,.0f} exceeds available "
                            f"₹{self._margin_ceiling - self._deployed_margin:,.0f} "
                            f"(deployed ₹{self._deployed_margin:,.0f} / "
                            f"ceiling ₹{self._margin_ceiling:,.0f})."
                        )
                        continue
                    trade.legs.append(new_leg)
                    nts = self.dm.get_option_timeseries(
                        date=date,
                        expiry_date=new_leg.expiry,
                        right=new_leg.right.value,
                        strike=new_leg.strike,
                    )
                    if not nts.empty:
                        leg_ts[new_leg.leg_id] = nts.set_index("datetime").sort_index()
                pending_reentries = []

        for leg in trade.legs:
            if leg.status == LegStatus.OPEN:
                last_price = self._get_last_price(leg, leg_ts)
                self._close_leg(
                    leg,
                    all_timestamps[-1] if all_timestamps else date,
                    last_price,
                    reason="EOD Force Close",
                )

        # Hand the true peak concurrent deployment to reporting; this is the
        # figure that must respect the 10L ceiling, not the gross leg sum.
        trade.peak_margin_deployed = self._peak_margin

        return trade

    def _shift_sibling_stops_to_breakeven(self, trade: Trade, stopped_leg: TradeLeg) -> None:
        """Move surviving same-strategy SELL legs' stops to their cost price.

        Implements the Short Straddle rule: once one leg hits its stop, the other
        leg's stop is shifted to its own entry premium (breakeven), so the worst
        case on the survivor becomes flat rather than a further loss.
        """
        for other in trade.legs:
            if other is stopped_leg or other.status != LegStatus.OPEN:
                continue
            if other.direction != "SELL" or other.strategy_label != stopped_leg.strategy_label:
                continue
            # SELL stop triggers when premium rises to the level; entry premium = breakeven.
            other.stop_loss_level = other.entry_premium

    def _next_orb_reentry(self, trade: Trade, ts: pd.Timestamp) -> Optional[TradeLeg]:
        """Pop the next ORB re-entry candidate whose breakout falls after ``ts``.

        Candidates whose breakout occurred while the prior leg was still open are
        stale (we couldn't have taken them) and are discarded. The returned leg
        carries its own future ``entry_time``, so the main loop defers managing it
        until that bar arrives.
        """
        queue = trade.orb_reentry_candidates
        while queue:
            candidate = queue.pop(0)
            if candidate.entry_time > ts:
                # Reprice lots using the budget remaining after realised P&L.
                remaining = self._remaining_budget()
                cost_per_lot = candidate.entry_premium * candidate.lot_size
                if cost_per_lot <= 0:
                    continue
                new_lots = int(remaining // cost_per_lot)
                if new_lots < 1:
                    logger.warning(
                        f"  ORB re-entry {candidate.leg_id} SKIPPED: "
                        f"remaining budget ₹{remaining:,.0f} < 1 lot cost ₹{cost_per_lot:,.0f}"
                    )
                    continue
                candidate.num_lots = new_lots
                candidate.margin_blocked = cost_per_lot * new_lots
                return candidate
        return None

    def _next_wall_reentry(
        self, trade: Trade, ts: pd.Timestamp, right
    ) -> Optional[TradeLeg]:
        """Pop the next Wall Reversion re-entry candidate for ``right`` after ``ts``.

        Candidates whose signal fired while the prior leg was still open are
        stale and discarded. Lots are repriced from the remaining day budget.
        """
        queue = trade.wall_reentry_candidates
        i = 0
        while i < len(queue):
            candidate = queue[i]
            if candidate.right != right:
                i += 1
                continue
            queue.pop(i)
            if candidate.entry_time <= ts:
                continue  # stale — signal fired while we were still in the prior leg
            remaining = self._remaining_budget()
            cost_per_lot = candidate.entry_premium * candidate.lot_size
            if cost_per_lot <= 0:
                continue
            new_lots = int(remaining // cost_per_lot)
            if new_lots < 1:
                logger.warning(
                    f"  Wall re-entry {candidate.leg_id} SKIPPED: "
                    f"remaining budget ₹{remaining:,.0f} < 1 lot cost ₹{cost_per_lot:,.0f}"
                )
                continue
            candidate.num_lots = new_lots
            candidate.margin_blocked = cost_per_lot * new_lots
            return candidate
        return None


    def _close_all_legs(
        self,
        trade: Trade,
        ts: pd.Timestamp,
        leg_ts: Dict[str, pd.DataFrame],
        reason: str,
    ) -> None:
        for leg in trade.legs:
            if leg.status != LegStatus.OPEN:
                continue
            price = self._get_price_at(leg, ts, leg_ts)
            self._close_leg(leg, ts, price, reason)

    def _close_leg(
        self,
        leg: TradeLeg,
        ts: pd.Timestamp,
        price: float,
        reason: str,
    ) -> None:
        if leg.status != LegStatus.OPEN:
            return

        if price <= 0:
            if reason in ["Exit Time", "EOD Force Close", "Square-Off"]:
                price = 0.05
            else:
                return

        if leg.direction == "BUY":
            raw_pnl = (price - leg.entry_premium) * leg.lot_size * leg.num_lots
            leg.exit_time = ts
            leg.exit_premium = price
            leg.exit_reason = reason
            leg.status = LegStatus.CLOSED
            leg.net_pnl = (
                raw_pnl
                - compute_transaction_cost(price, leg.lot_size, leg.num_lots, is_entry=False)
                - compute_transaction_cost(
                    leg.entry_premium, leg.lot_size, leg.num_lots, is_entry=True
                )
            )
        else:
            leg.close(ts, price, reason)

        # Track realised P&L so re-entry sizing can shrink the budget after losses.
        self._cumulative_pnl += leg.net_pnl

        # The position is now flat — return its margin so a later re-entry can
        # recycle the freed capital instead of stacking fresh margin.
        self._release_margin(leg)

    def _get_price_at(
        self,
        leg: TradeLeg,
        ts: pd.Timestamp,
        leg_ts: Dict[str, pd.DataFrame],
    ) -> float:
        if leg.leg_id not in leg_ts:
            return leg.entry_premium * 0.05
        df = leg_ts[leg.leg_id]
        if ts in df.index:
            return float(df.loc[ts, "close"])
        return self._get_last_price(leg, leg_ts)

    def _get_last_price(self, leg: TradeLeg, leg_ts: Dict[str, pd.DataFrame]) -> float:
        if leg.leg_id not in leg_ts:
            return leg.entry_premium * 0.05
        df = leg_ts[leg.leg_id]
        return float(df["close"].iloc[-1]) if not df.empty else leg.entry_premium * 0.05

    def check_capital_sufficiency(self, trade: Trade, available_capital: float) -> bool:
        """Whether the account can fund the trade's total margin."""
        required = trade.total_margin
        if required > available_capital:
            logger.warning(
                f"Trade #{trade.trade_id} | SKIPPED: "
                f"Required ₹{required:,.0f} > Available ₹{available_capital:,.0f}"
            )
            return False
        return True
