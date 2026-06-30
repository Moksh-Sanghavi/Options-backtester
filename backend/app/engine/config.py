"""
Pydantic strategy configuration.

`StrategyConfig` replaces the original hard-coded dataclass so that every
strategy parameter can be supplied dynamically (e.g. from an API request body)
with validation. The engine reads attributes off this model exactly as it did
the dataclass.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from .constants import NIFTY_LOT_SIZE, NIFTY_STRIKE_STEP, RunMode, StrategyType


class StrategyConfig(BaseModel):
    """All user-configurable strategy parameters (validated)."""

    strategy_type: StrategyType = Field(
        default=StrategyType.WALL_REVERSION,
        description="Primary strategy family label.",
    )
    run_mode: RunMode = Field(
        default=RunMode.COMBINED,
        description="Which Wall/ORB combination to run: WALL_ONLY, ORB_ONLY, or COMBINED. "
        "Kept for back-compat; the explicit *_enabled flags below take precedence when set.",
    )

    # ── Per-strategy enable switches ────────────────────────────────────────
    # When None, Wall/ORB participation falls back to ``run_mode`` (legacy
    # behaviour, preserved for the golden tests). The UI sets these explicitly so
    # each strategy can be toggled independently. Short Straddle is orthogonal to
    # ``run_mode`` and governed solely by its own flag.
    wall_enabled: Optional[bool] = Field(
        default=None, description="Run Wall Reversion (overrides run_mode when set)."
    )
    orb_enabled: Optional[bool] = Field(
        default=None, description="Run Opening Range Breakout (overrides run_mode when set)."
    )
    straddle_enabled: bool = Field(
        default=False, description="Run the Short Straddle strategy."
    )

    entry_time: str = Field(default="09:20", description="HH:MM scan start time.")
    exit_time: str = Field(default="15:15", description="HH:MM forced square-off time.")
    expiry_selection: str = Field(
        default="nearest",
        description="'nearest' or an explicit expiry date (YYYY-MM-DD).",
    )

    # ── Opening Range Breakout ──────────────────────────────────────────────
    orb_minutes: int = Field(default=15, ge=1, le=120, description="Opening range length (min).")
    orb_cutoff_time: str = Field(default="13:30", description="HH:MM latest breakout entry.")

    # ── Wall Reversion (IV anomaly) ─────────────────────────────────────────
    iv_drop_threshold: float = Field(
        default=0.001, ge=0.0, le=1.0, description="Min IV drop between strikes to count as anomaly."
    )
    required_anomalies: int = Field(
        default=3, ge=1, le=10, description="Number of anomalies required to trigger entry."
    )

    # ── Capital allocation & sizing ─────────────────────────────────────────
    capital: float = Field(default=1_000_000.0, gt=0, description="Account capital (INR).")
    lot_size: int = Field(default=NIFTY_LOT_SIZE, gt=0, description="Contract lot size.")
    strike_step: int = Field(default=NIFTY_STRIKE_STEP, gt=0, description="Strike interval.")
    risk_free_rate: float = Field(
        default=0.065, ge=0.0, le=0.5,
        description="Continuously-compounded risk-free rate used for Black-Scholes "
        "implied-vol inversion and the portfolio Greeks (e.g. 0.065 = 6.5%).",
    )

    # ── Exit / protective stops ─────────────────────────────────────────────
    stop_loss_pct: float = Field(
        default=0.25, gt=0.0, le=1.0,
        description="Initial stop-loss as a fraction below entry (e.g. 0.25 = -25%).",
    )
    trailing_sl_pct: float = Field(
        default=0.15, gt=0.0, le=1.0,
        description="Trailing-stop distance from the peak (fraction of entry) once +1R is reached.",
    )
    max_hold_bars: int = Field(
        default=45, ge=1, le=375,
        description="Max 1-minute bars to hold a leg before a time-decay force exit "
        "(375 = full 09:15–15:30 session, i.e. hold until EOD / square-off).",
    )
    take_profit_pct: float = Field(
        default=0.0, ge=0.0, le=10.0,
        description="Take-profit as a fraction above entry (e.g. 0.5 = +50%); 0 disables it.",
    )
    max_reentries: int = Field(
        default=0, ge=0, le=5,
        description="Times a stopped-out leg may be re-entered on the same contract that day.",
    )

    # ── Per-strategy exit overrides ─────────────────────────────────────────
    # Each strategy now carries its own exit rules. When an override is None the
    # engine falls back to the shared values above (keeps legacy configs working).
    wall_stop_loss_pct: Optional[float] = Field(default=None, gt=0.0, le=1.0)
    wall_trailing_sl_pct: Optional[float] = Field(default=None, gt=0.0, le=1.0)
    wall_max_hold_bars: Optional[int] = Field(default=None, ge=1, le=375)
    wall_take_profit_pct: Optional[float] = Field(default=None, ge=0.0, le=10.0)

    orb_stop_loss_pct: Optional[float] = Field(default=None, gt=0.0, le=1.0)
    orb_trailing_sl_pct: Optional[float] = Field(default=None, gt=0.0, le=1.0)
    orb_max_hold_bars: Optional[int] = Field(default=None, ge=1, le=375)
    orb_take_profit_pct: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    orb_max_reentries: Optional[int] = Field(
        default=None, ge=0, le=5,
        description="ORB dynamic re-entries: after a stop-out, re-arm on the opening "
        "range and re-enter on the next fresh breakout with a freshly-computed ATM "
        "strike. Falls back to max_reentries when unset.",
    )

    # ── Short Straddle ──────────────────────────────────────────────────────
    # Sell 1 ATM call + 1 ATM put at the entry time, square off at the exit time.
    # Each leg carries a fixed stop-loss; when one leg stops out the surviving
    # leg's stop is shifted to its own cost price (breakeven). That cross-leg
    # behaviour is fixed in the execution engine — only these knobs are tunable.
    straddle_entry_time: str = Field(
        default="10:00", description="HH:MM Short Straddle entry time."
    )
    straddle_exit_time: str = Field(
        default="14:45", description="HH:MM Short Straddle square-off time."
    )
    straddle_stop_loss_pct: float = Field(
        default=0.30, gt=0.0, le=1.0,
        description="Per-leg stop-loss for the Short Straddle (fraction above entry).",
    )

    # ── Advanced engine internals (sensible defaults; rarely changed) ────────
    ema_period: int = Field(
        default=20, ge=2, le=200, description="Intraday EMA period used as the trend filter."
    )
    cooldown_minutes: int = Field(
        default=30, ge=0, le=240, description="Per-side cooldown between Wall Reversion entries."
    )
    iv_scan_depth: int = Field(
        default=10, ge=1, le=20, description="Strikes scanned each side when hunting IV anomalies."
    )
    participation: float = Field(
        default=0.10, gt=0.0, le=1.0, description="Max share of recent volume a fill may consume."
    )
    fill_window: int = Field(
        default=5, ge=1, le=30, description="Lookback (minutes) for the liquidity/volume check."
    )
    entry_min_vol: int = Field(
        default=50, ge=0, description="Minimum entry-bar volume required to allow a fill."
    )
    capital_deploy_pct: float = Field(
        default=0.95, gt=0.0, le=1.0,
        description="Fraction of capital deployable as margin (the daily margin ceiling).",
    )

    model_config = {"use_enum_values": False}
