"""
Strategy engine: builds the day's `Trade` from Wall Reversion (IV anomaly) and
Opening Range Breakout setups, governed by the configured run mode.
"""
from __future__ import annotations

import logging
from typing import List, Optional

import pandas as pd

from .config import StrategyConfig
from .constants import OptionRight, RunMode
from .data_manager import DataManager
from .iv import implied_volatility_call, implied_volatility_put
from .models import Trade, TradeLeg

logger = logging.getLogger("OptionsBacktester.Strategy")


class Strategy:
    """Builds trades for Wall Reversion and Opening Range Breakout setups."""

    def __init__(self, config: StrategyConfig, data_manager: DataManager) -> None:
        self.config = config
        self.dm = data_manager
        self._trade_counter = 0
        logger.info(f"Strategy Engine initialised: {config.strategy_type.value}")

    @staticmethod
    def get_atm_strike(spot_price: float, step: int = 50) -> float:
        """Round spot to the nearest strike step (ATM strike)."""
        return round(spot_price / step) * step

    def _resolve_exits(self, prefix: str) -> dict:
        """Per-strategy exit rules, falling back to the shared values when unset.

        ``prefix`` is "wall" or "orb"; reads ``<prefix>_stop_loss_pct`` etc. off
        the config and substitutes the legacy shared field when the override is
        None. Returns a kwargs dict ready to splat into ``TradeLeg``.
        """
        c = self.config
        sl = getattr(c, f"{prefix}_stop_loss_pct")
        tsl = getattr(c, f"{prefix}_trailing_sl_pct")
        mhb = getattr(c, f"{prefix}_max_hold_bars")
        tp = getattr(c, f"{prefix}_take_profit_pct")
        return {
            "stop_loss_pct": sl if sl is not None else c.stop_loss_pct,
            "trailing_sl_pct": tsl if tsl is not None else c.trailing_sl_pct,
            "max_hold_bars": mhb if mhb is not None else c.max_hold_bars,
            "take_profit_pct": (tp if tp is not None else c.take_profit_pct) or 999.0,
        }

    def _get_expiry(self, date: pd.Timestamp) -> Optional[pd.Timestamp]:
        """Resolve the expiry to trade for ``date`` per ``expiry_selection``."""
        available = self.dm.get_available_expiries(date)
        if not available:
            return None
        if self.config.expiry_selection == "nearest":
            future = [e for e in available if e >= date]
            return future[0] if future else available[-1]
        target = pd.Timestamp(self.config.expiry_selection)
        if target in available:
            return target
        return min(available, key=lambda e: abs(e - target))

    def build_trade(self, date: pd.Timestamp) -> Optional[Trade]:
        """Orchestrate leg construction for the day, honouring the run mode."""
        self._trade_counter += 1

        entry_h, entry_m = map(int, self.config.entry_time.split(":"))
        entry_ts = date + pd.Timedelta(hours=entry_h, minutes=entry_m)
        expiry = self._get_expiry(date)

        if expiry is None:
            return None

        trade = Trade(trade_id=self._trade_counter, strategy_type="PENDING", date=date)

        capital_ceiling = self.config.capital * self.config.capital_deploy_pct
        current_margin_used = 0.0
        mode = self.config.run_mode

        # Resolve which strategies run. The explicit *_enabled flags take
        # precedence; when unset, Wall/ORB fall back to the legacy run_mode.
        cfg = self.config
        run_wall = (
            cfg.wall_enabled
            if cfg.wall_enabled is not None
            else mode in (RunMode.WALL_ONLY, RunMode.COMBINED)
        )
        run_orb = (
            cfg.orb_enabled
            if cfg.orb_enabled is not None
            else mode in (RunMode.ORB_ONLY, RunMode.COMBINED)
        )

        def admit(leg) -> bool:
            """Append the leg if it fits the daily margin ceiling."""
            nonlocal current_margin_used
            if current_margin_used + leg.margin_blocked <= capital_ceiling:
                trade.legs.append(leg)
                current_margin_used += leg.margin_blocked
                return True
            logger.warning(f"  {leg.strategy_label} Leg {leg.leg_id} skipped: Margin limit hit.")
            return False

        def label(name: str) -> None:
            """Track the trade-level strategy label (COMBINED once mixed)."""
            if trade.strategy_type in ("PENDING", name):
                trade.strategy_type = name
            else:
                trade.strategy_type = "COMBINED"

        # PRIORITY 1: Wall Reversion
        if run_wall:
            wall_legs, wall_candidates = self._build_wall_reversion_legs(date, entry_ts, expiry)
            for leg in wall_legs:
                leg.strategy_label = "Wall Reversion"
                if admit(leg):
                    label("Wall Reversion")
            for cand in wall_candidates:
                cand.strategy_label = "Wall Reversion"
            trade.wall_reentry_candidates = wall_candidates

        # PRIORITY 2: ORB
        if run_orb:
            orb_legs, orb_candidates = self._build_orb_legs(date, expiry)
            for leg in orb_legs:
                leg.strategy_label = "ORB"
                if admit(leg):
                    label("ORB")
            # Stage dynamic re-entry candidates for the execution engine to
            # activate after a stop-out (fresh breakouts, freshly-priced ATM).
            for cand in orb_candidates:
                cand.strategy_label = "ORB"
            trade.orb_reentry_candidates = orb_candidates

        # PRIORITY 3: Short Straddle (orthogonal to run_mode)
        if cfg.straddle_enabled:
            for leg in self._build_straddle_legs(date, expiry):
                leg.strategy_label = "Short Straddle"
                if admit(leg):
                    label("Short Straddle")

        if not trade.legs:
            return None

        logger.info(
            f"Trade #{trade.trade_id} | {date.date()} | Strategy: {trade.strategy_type} | "
            f"Margin Used: ₹{current_margin_used:,.0f} | Total Legs: {len(trade.legs)}"
        )
        return trade

    def _build_wall_reversion_legs(
        self, date: pd.Timestamp, start_entry_ts: pd.Timestamp, expiry: pd.Timestamp
    ) -> tuple[List[TradeLeg], List[TradeLeg]]:
        """Scan the IV curve for volatility anomalies and build reversion legs.

        Returns ``(initial_legs, reentry_candidates)``:
        - **initial_legs** — the first qualifying signal per side (call/put).
        - **reentry_candidates** — all later signals, queued for dynamic re-entry
          after a stop-out. Lots are repriced by the execution engine at activation
          time using the remaining day budget.
        Filter order: IV anomaly first, then spot-vs-EMA gate.
        """
        mask = (self.dm.spot_df["datetime"] >= start_entry_ts) & (
            self.dm.spot_df["datetime"].dt.date == date.date()
        )
        valid_minutes = self.dm.spot_df[mask]["datetime"].tolist()

        r = 0.065
        scans = [
            (OptionRight.CALL, 1, 300, implied_volatility_call),
            (OptionRight.PUT, -1, -300, implied_volatility_put),
        ]

        iv_drop_threshold = self.config.iv_drop_threshold
        required_anomalies = self.config.required_anomalies
        ema_period = self.config.ema_period
        max_re = self.config.max_reentries

        exits = self._resolve_exits("wall")
        initial_legs: List[TradeLeg] = []
        candidates: List[TradeLeg] = []
        last_entry_time = {OptionRight.CALL: None, OptionRight.PUT: None}
        initial_entered = {OptionRight.CALL: False, OptionRight.PUT: False}
        cooldown_minutes = self.config.cooldown_minutes

        margin_budget = self.config.capital * self.config.capital_deploy_pct

        for current_ts in valid_minutes:
            spot = self.dm.get_spot_price(current_ts)
            ema = self.dm.get_spot_ema(current_ts, period=ema_period)
            atm = self.get_atm_strike(spot, self.config.strike_step)

            exact_expiry = expiry + pd.Timedelta(hours=15, minutes=30)
            seconds_to_expiry = max(1.0, (exact_expiry - current_ts).total_seconds())
            T = seconds_to_expiry / (365.0 * 86400.0)

            for right, step_dir, target_offset, iv_calc in scans:
                # Cooldown: space out signals per side.
                if last_entry_time[right] is not None:
                    minutes_since_last = (current_ts - last_entry_time[right]).total_seconds() / 60.0
                    if minutes_since_last < cooldown_minutes:
                        continue

                # ── Step 1: IV anomaly scan ──────────────────────────────────
                valid_iv_curve = []
                for i in range(1, self.config.iv_scan_depth + 1):
                    strike = atm + (i * step_dir * self.config.strike_step)
                    price = self.dm.get_option_price(
                        current_ts, expiry, right.value, strike, price_col="close"
                    )
                    if price is not None and price > 0.50:
                        iv = iv_calc(spot, strike, T, r, price)
                        if iv > 0.005:
                            valid_iv_curve.append((strike, iv))

                abnormalities = 0
                for j in range(1, len(valid_iv_curve)):
                    prev_iv = valid_iv_curve[j - 1][1]
                    curr_iv = valid_iv_curve[j][1]
                    if curr_iv <= (prev_iv - iv_drop_threshold):
                        abnormalities += 1

                if abnormalities < required_anomalies:
                    continue

                # ── Step 2: EMA direction gate (checked only after IV passes) ─
                if right == OptionRight.CALL and spot <= ema:
                    continue
                if right == OptionRight.PUT and spot >= ema:
                    continue

                # ── Build the leg ────────────────────────────────────────────
                target_strike = atm + target_offset
                entry_price = self.dm.get_option_price(
                    current_ts, expiry, right.value, target_strike, price_col="open"
                )
                if entry_price is None or entry_price <= 0:
                    continue

                cost_per_lot = entry_price * self.config.lot_size
                if cost_per_lot <= 0:
                    continue

                # Liquidity filters (initial leg only; re-entries are repriced live).
                vbar = self.dm.get_option_timeseries(date, expiry, right.value, target_strike)
                ebar = vbar[vbar["datetime"] == current_ts]
                entry_bar_vol = float(ebar["volume"].iloc[-1]) if not ebar.empty else 0.0
                if entry_bar_vol < self.config.entry_min_vol:
                    continue

                win = vbar[
                    (vbar["datetime"] <= current_ts)
                    & (vbar["datetime"] > current_ts - pd.Timedelta(minutes=self.config.fill_window))
                ]
                avail_vol = float(win["volume"].sum())
                max_lots_liq = int((avail_vol * self.config.participation) // self.config.lot_size)

                dynamic_lots = int(margin_budget // cost_per_lot)
                dynamic_lots = min(dynamic_lots, max_lots_liq)
                if dynamic_lots < 1:
                    continue

                margin = cost_per_lot * dynamic_lots
                tag = "ENTRY" if not initial_entered[right] else f"RE{len([c for c in candidates if c.right == right]) + 1}"

                leg = TradeLeg(
                    leg_id=(
                        f"T{self._trade_counter}_{right.value[:1]}{int(target_strike)}"
                        f"_IV_{tag}_{current_ts.strftime('%H%M')}"
                    ),
                    right=right,
                    strike=target_strike,
                    expiry=expiry,
                    entry_time=current_ts,
                    entry_premium=entry_price,
                    lot_size=self.config.lot_size,
                    num_lots=dynamic_lots,
                    direction="BUY",
                    stop_loss_pct=exits["stop_loss_pct"],
                    trailing_sl_pct=exits["trailing_sl_pct"],
                    take_profit_pct=exits["take_profit_pct"],
                    max_hold_bars=exits["max_hold_bars"],
                    margin_blocked=margin,
                    reentries_left=0,
                )
                logger.info(
                    f"  WALL IV {tag} @ {current_ts.time()} | {right.value} | "
                    f"Buying {int(target_strike)} @ ₹{entry_price:.2f} | "
                    f"Lots: {dynamic_lots} | Spot: {spot:.2f} | EMA: {ema:.2f}"
                )

                if not initial_entered[right]:
                    initial_legs.append(leg)
                    initial_entered[right] = True
                elif max_re > 0 and len([c for c in candidates if c.right == right]) < max_re:
                    candidates.append(leg)

                last_entry_time[right] = current_ts

        return initial_legs, candidates

    def _make_orb_leg(
        self,
        date: pd.Timestamp,
        expiry: pd.Timestamp,
        current_ts: pd.Timestamp,
        spot_close: float,
        is_call: bool,
        exits: dict,
        reentries_left: int,
        tag: str,
    ) -> Optional[TradeLeg]:
        """Build a single ATM ORB leg for a breakout at ``current_ts``.

        Shared by the initial entry and every dynamic re-entry: the ATM strike
        and premium are computed from the *current* spot, so a re-entry an hour
        later trades a brand-new contract priced to the market at that moment.
        Returns None when the option is unpriced or risk-sizing yields < 1 lot.
        """
        right = OptionRight.CALL if is_call else OptionRight.PUT
        atm_strike = self.get_atm_strike(spot_close, self.config.strike_step)

        entry_price = self.dm.get_option_price(
            current_ts, expiry, right.value, atm_strike, price_col="open"
        )
        if entry_price is None or entry_price <= 0:
            return None

        # Full-budget sizing: buy as many lots as the daily margin ceiling allows.
        # The ceiling (capital × capital_deploy_pct) is the hard cap on concurrent
        # deployment; re-entries recycle freed capital rather than stacking.
        # EMA alignment is still checked by the caller as a signal gate.
        margin_budget = self.config.capital * self.config.capital_deploy_pct
        cost_per_lot = entry_price * self.config.lot_size
        if cost_per_lot <= 0:
            return None
        dynamic_lots = int(margin_budget // cost_per_lot)
        if dynamic_lots < 1:
            return None

        margin = entry_price * self.config.lot_size * dynamic_lots

        leg = TradeLeg(
            leg_id=f"T{self._trade_counter}_ORB_{right.value[:1]}_{int(atm_strike)}_{tag}",
            right=right,
            strike=atm_strike,
            expiry=expiry,
            entry_time=current_ts,
            entry_premium=entry_price,
            lot_size=self.config.lot_size,
            num_lots=dynamic_lots,
            direction="BUY",
            stop_loss_pct=exits["stop_loss_pct"],
            trailing_sl_pct=exits["trailing_sl_pct"],
            take_profit_pct=exits["take_profit_pct"],
            max_hold_bars=exits["max_hold_bars"],
            margin_blocked=margin,
            reentries_left=reentries_left,
        )

        ema_20 = self.dm.get_spot_ema(current_ts, period=self.config.ema_period)
        logger.info(
            f"  ORB {tag} @ {current_ts.time()} | {right.value} | "
            f"Spot: {spot_close:.2f} | EMA: {ema_20:.2f} | "
            f"Buying {dynamic_lots} Lots @ ₹{entry_price:.2f}"
        )
        return leg

    def _build_orb_legs(
        self, date: pd.Timestamp, expiry: pd.Timestamp
    ) -> tuple[List[TradeLeg], List[TradeLeg]]:
        """Build the initial ORB breakout leg plus dynamic re-entry candidates.

        Returns ``(initial_legs, reentry_candidates)``:

        * **initial_legs** — the first opening-range breakout of the day (the same
          behaviour as before, so existing results are unchanged).
        * **reentry_candidates** — pre-built legs for each *subsequent* fresh
          breakout (price re-entered the range, then crossed a level again), up to
          ``orb_max_reentries`` and before ``orb_cutoff_time``. The execution
          engine activates the next candidate after a stop-out. Empty unless ORB
          re-entries are enabled.
        """
        market_open_ts = date + pd.Timedelta(hours=9, minutes=15)
        orb_end_ts = market_open_ts + pd.Timedelta(minutes=self.config.orb_minutes)

        mask = self.dm.spot_df["datetime"].dt.date == date.date()
        day_spot = self.dm.spot_df[mask]
        if day_spot.empty:
            return [], []

        orb_window = day_spot[day_spot["datetime"] <= orb_end_ts]
        if orb_window.empty:
            return [], []

        orb_high = float(orb_window["high"].max())
        orb_low = float(orb_window["low"].min())

        exits = self._resolve_exits("orb")
        rows = day_spot[day_spot["datetime"] > orb_end_ts].to_dict("records")
        if not rows:
            return [], []

        c = self.config
        max_re = c.orb_max_reentries if c.orb_max_reentries is not None else c.max_reentries

        ch, cm = map(int, c.orb_cutoff_time.split(":"))
        cutoff_ts = date + pd.Timedelta(hours=ch, minutes=cm)

        # ── Initial breakout: first bar to close beyond the range. ──────────
        initial_legs: List[TradeLeg] = []
        initial_idx: Optional[int] = None
        for i, row in enumerate(rows):
            spot_close = float(row["close"])
            if spot_close > orb_high or spot_close < orb_low:
                leg = self._make_orb_leg(
                    date, expiry, row["datetime"], spot_close,
                    spot_close > orb_high, exits, max_re, "ENTRY",
                )
                if leg is not None:
                    initial_legs.append(leg)
                    initial_idx = i
                    break

        if initial_idx is None or max_re <= 0:
            return initial_legs, []

        # ── Dynamic re-entries: each later *fresh* crossing of a level. ──────
        # A fresh crossing requires the prior bar to be back inside the level —
        # i.e. price dipped below the ORB high (or back above the low) and then
        # broke out again, exactly the "second breakout" the user described.
        candidates: List[TradeLeg] = []
        prev_close = float(rows[initial_idx]["close"])
        for i in range(initial_idx + 1, len(rows)):
            if len(candidates) >= max_re:
                break
            ts = rows[i]["datetime"]
            if ts > cutoff_ts:
                break
            spot_close = float(rows[i]["close"])
            is_call_x = spot_close > orb_high and prev_close <= orb_high
            is_put_x = spot_close < orb_low and prev_close >= orb_low
            if is_call_x or is_put_x:
                leg = self._make_orb_leg(
                    date, expiry, ts, spot_close, is_call_x, exits,
                    max_re, f"RE{len(candidates) + 1}",
                )
                if leg is not None:
                    candidates.append(leg)
            prev_close = spot_close

        return initial_legs, candidates

    def _build_straddle_legs(
        self, date: pd.Timestamp, expiry: pd.Timestamp
    ) -> List[TradeLeg]:
        """Short Straddle: sell 1 ATM call + 1 ATM put at the entry time.

        Both legs carry a fixed stop-loss (``straddle_stop_loss_pct``) and a
        square-off at ``straddle_exit_time``. The breakeven-shift rule (when one
        leg stops out, the other's stop moves to its cost price) lives in the
        execution engine, which manages the SELL legs intraday.
        """
        c = self.config
        eh, em = map(int, c.straddle_entry_time.split(":"))
        entry_ts = date + pd.Timedelta(hours=eh, minutes=em)
        sh, sm = map(int, c.straddle_exit_time.split(":"))
        square_off_ts = date + pd.Timedelta(hours=sh, minutes=sm)

        spot = self.dm.get_spot_price(entry_ts)
        if spot is None or spot <= 0:
            return []
        atm = self.get_atm_strike(spot, c.strike_step)

        call_price = self.dm.get_option_price(
            entry_ts, expiry, OptionRight.CALL.value, atm, price_col="open"
        )
        put_price = self.dm.get_option_price(
            entry_ts, expiry, OptionRight.PUT.value, atm, price_col="open"
        )
        if not call_price or not put_price or call_price <= 0 or put_price <= 0:
            return []

        sl_pct = c.straddle_stop_loss_pct

        margin_budget = c.capital * c.capital_deploy_pct
        cost_per_lot = (call_price + put_price) * c.lot_size
        if cost_per_lot <= 0:
            return []
        lots = int(margin_budget // cost_per_lot)
        if lots < 1:
            return []

        legs: List[TradeLeg] = []
        for right, premium in ((OptionRight.CALL, call_price), (OptionRight.PUT, put_price)):
            legs.append(
                TradeLeg(
                    leg_id=f"T{self._trade_counter}_STDL_{right.value[:1]}_{int(atm)}",
                    right=right,
                    strike=atm,
                    expiry=expiry,
                    entry_time=entry_ts,
                    entry_premium=premium,
                    lot_size=c.lot_size,
                    num_lots=lots,
                    direction="SELL",
                    stop_loss_pct=sl_pct,
                    trailing_sl_pct=0.0,  # fixed stop; no trailing for the straddle
                    take_profit_pct=999.0,
                    max_hold_bars=375,  # hold to square-off; only stop/square-off exit
                    square_off_time=square_off_ts,
                    margin_blocked=premium * c.lot_size * lots,
                )
            )

        logger.info(
            f"  SHORT STRADDLE @ {entry_ts.time()} | ATM {int(atm)} | "
            f"Sell C @ ₹{call_price:.2f} + P @ ₹{put_price:.2f} | Lots: {lots} | "
            f"SL: {sl_pct:.0%} | Square-off: {square_off_ts.time()}"
        )
        return legs
