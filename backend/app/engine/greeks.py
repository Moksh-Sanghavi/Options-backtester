"""
Portfolio Greeks pipeline.

Computes the aggregate Black-Scholes risk profile (Delta, Gamma, Theta, Vega) of
the strategy's option positions on each trading day.

Implied volatility is **backed out of each leg's traded entry premium** (given the
spot at entry, the strike, the time to expiry, and the risk-free rate) using the
same Brent solvers the Wall-Reversion IV scan relies on — so the Greeks reflect
the actual market vol the position was opened at, not an assumed flat surface.
Per-contract Greeks are then evaluated and aggregated across every leg, *signed*
by trade direction (+ for BUY, − for SELL) and scaled by contract size
(``lot_size × num_lots``), yielding a true portfolio-level exposure per day.

The output is a chronological list of ``{date, delta, gamma, theta, vega, spot}``
dicts, mirroring the shape of ``build_equity_curve`` / ``_build_benchmark`` so the
API layer can serialise it without further massaging.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List

import numpy as np
import pandas as pd
from scipy.stats import norm

from .constants import OptionRight
from .iv import implied_volatility_call, implied_volatility_put
from .models import Trade

# India short-term G-Sec yield; mirrors the rate used in the IV scan (strategy.py).
RISK_FREE_RATE = 0.065

# Year length in seconds — matches the strategy's ``T = secs / (365 * 86400)``.
_YEAR_SECONDS = 365.0 * 86400.0
# Index options stop trading at the 15:30 close on their expiry day.
_EXPIRY_CLOSE = pd.Timedelta(hours=15, minutes=30)
# Floor for time-to-expiry (seconds) so 0-DTE Greeks stay finite.
_MIN_SECONDS = 1.0

# Spot accessor: maps an intraday timestamp to the underlying close at/just before it.
SpotFn = Callable[[pd.Timestamp], float]


def _d1(S: float, K: float, T: float, r: float, sigma: float) -> float:
    return (np.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * np.sqrt(T))


def bs_greeks(
    S: float, K: float, T: float, r: float, sigma: float, right: OptionRight
) -> Dict[str, float]:
    """Per-contract (one unit of underlying) Black-Scholes Greeks.

    Returns, on risk-sheet conventions:
        delta — ∂V/∂S, in [0, 1] for calls and [-1, 0] for puts.
        gamma — ∂²V/∂S², identical for calls and puts.
        theta — ∂V/∂t expressed **per calendar day** (annual θ ÷ 365); negative
                for long options (time decay).
        vega  — ∂V/∂σ expressed **per +1% absolute change in IV** (raw vega ÷ 100).

    Degenerate inputs (non-positive T, σ, S or K) return all-zero Greeks rather
    than raising, so a single bad leg can't break the daily aggregate.
    """
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}

    sqrt_t = np.sqrt(T)
    d1 = _d1(S, K, T, r, sigma)
    d2 = d1 - sigma * sqrt_t
    pdf = norm.pdf(d1)
    disc = np.exp(-r * T)

    gamma = pdf / (S * sigma * sqrt_t)
    vega = S * pdf * sqrt_t
    decay = -S * pdf * sigma / (2.0 * sqrt_t)

    if right == OptionRight.CALL:
        delta = norm.cdf(d1)
        theta = decay - r * K * disc * norm.cdf(d2)
    else:
        delta = norm.cdf(d1) - 1.0
        theta = decay + r * K * disc * norm.cdf(-d2)

    return {
        "delta": float(delta),
        "gamma": float(gamma),
        "theta": float(theta / 365.0),  # per calendar day
        "vega": float(vega / 100.0),    # per +1% IV
    }


def _leg_time_to_expiry(entry_ts: pd.Timestamp, expiry: Any) -> float:
    """Time to expiry in years from ``entry_ts`` to the 15:30 expiry-day close."""
    expiry_close = pd.Timestamp(expiry).normalize() + _EXPIRY_CLOSE
    secs = max(_MIN_SECONDS, (expiry_close - entry_ts).total_seconds())
    return secs / _YEAR_SECONDS


def build_greeks_timeseries(
    trades: List[Trade],
    spot_at: SpotFn,
    rate: float = RISK_FREE_RATE,
) -> List[Dict[str, Any]]:
    """Aggregate per-day portfolio Greeks across every leg of every trade.

    Args:
        trades:  Completed trades from the run (each holds its legs and date).
        spot_at: Callable returning the underlying close at a given timestamp
                 (typically ``DataManager.get_spot_price``).
        rate:    Continuously-compounded risk-free rate for Black-Scholes.

    Returns:
        Chronologically-sorted list of
        ``{date, delta, gamma, theta, vega, spot}`` points (one per trading day
        that held a position). Days with no priceable legs are omitted.
    """
    by_date: Dict[pd.Timestamp, Dict[str, float]] = {}

    for trade in trades:
        day = pd.Timestamp(trade.date).normalize()
        for leg in trade.legs:
            entry_ts = pd.Timestamp(leg.entry_time)
            premium = float(leg.entry_premium)
            if pd.isna(entry_ts) or premium <= 0:
                continue

            try:
                spot = float(spot_at(entry_ts))
            except (ValueError, KeyError, IndexError):
                continue
            if spot <= 0:
                continue

            strike = float(leg.strike)
            t_years = _leg_time_to_expiry(entry_ts, leg.expiry)

            if leg.right == OptionRight.CALL:
                sigma = implied_volatility_call(spot, strike, t_years, rate, premium)
            else:
                sigma = implied_volatility_put(spot, strike, t_years, rate, premium)

            greeks = bs_greeks(spot, strike, t_years, rate, sigma, leg.right)

            # Signed contract quantity: long adds exposure, short subtracts it.
            sign = 1.0 if str(leg.direction).upper() == "BUY" else -1.0
            qty = sign * leg.lot_size * leg.num_lots

            acc = by_date.setdefault(
                day,
                {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "spot": spot},
            )
            acc["delta"] += greeks["delta"] * qty
            acc["gamma"] += greeks["gamma"] * qty
            acc["theta"] += greeks["theta"] * qty
            acc["vega"] += greeks["vega"] * qty
            acc["spot"] = spot  # underlying reference for the day (last leg seen)

    points: List[Dict[str, Any]] = []
    for day in sorted(by_date):
        acc = by_date[day]
        points.append(
            {
                "date": day.strftime("%Y-%m-%d"),
                "delta": round(acc["delta"], 2),
                "gamma": round(acc["gamma"], 4),
                "theta": round(acc["theta"], 2),
                "vega": round(acc["vega"], 2),
                "spot": round(acc["spot"], 2),
            }
        )
    return points
