"""
Shared constants and enums for the backtesting engine.

Holds NSE/NFO transaction-cost rates, instrument parameters, market hours,
and the enums used across the engine modules.
"""
from __future__ import annotations

from datetime import time
from enum import Enum

# ── NSE Transaction Cost Constants (FY2024-25) ──────────────────────────────
STT_RATE_SELL = 0.100 / 100
BROKERAGE_PER_ORDER = 20.0
EXCHANGE_TXNCHARGE = 0.053 / 100

GST_RATE = 18.0 / 100
SEBI_TURNOVER_FEE = 10.0 / 1e7
STAMP_DUTY = 0.003 / 100

# ── Instrument parameters ───────────────────────────────────────────────────
NIFTY_LOT_SIZE = 65
NIFTY_STRIKE_STEP = 50

# ── Market session ──────────────────────────────────────────────────────────
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)


class OptionRight(str, Enum):
    """Option right (Call / Put)."""

    CALL = "Call"
    PUT = "Put"


class StrategyType(str, Enum):
    """Supported strategy families."""

    WALL_REVERSION = "Wall Reversion"
    ORB = "Opening Range Breakout"
    SHORT_STRADDLE = "Short Straddle"


class RunMode(str, Enum):
    """Master switch controlling which strategies run in a session."""

    WALL_ONLY = "WALL_ONLY"
    ORB_ONLY = "ORB_ONLY"
    COMBINED = "COMBINED"


class LegStatus(str, Enum):
    """Lifecycle status of a single option leg."""

    OPEN = "OPEN"
    CLOSED = "CLOSED"
    STOPPED = "STOPPED"
