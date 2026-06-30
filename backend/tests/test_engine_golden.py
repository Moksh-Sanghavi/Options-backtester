"""
Golden-master tests for the backtesting engine.

These pin the *exact* output of a fixed backtest (a known week of the bundled
``nifty`` dataset) for each run mode. Their job is to catch silent behavioural
regressions during engine refactors — e.g. a fast-path rewrite that quietly
changes which trades fire or what they earn.

The baselines were captured from a known-good engine run. If you intentionally
change engine behaviour, re-capture and update the numbers below in the same PR.

Skipped automatically when the ``nifty`` Parquet dataset isn't present (it's too
large to commit), so the suite stays green on a fresh clone.
"""
from __future__ import annotations

import logging
import warnings

import pytest

from app.config import settings
from app.engine.backtester import Backtester
from app.engine.config import StrategyConfig

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)  # keep engine logs out of test output

OPTIONS_PATH, SPOT_PATH = settings.dataset_paths("nifty")
DATASET_AVAILABLE = OPTIONS_PATH.exists() and SPOT_PATH.exists()

pytestmark = pytest.mark.skipif(
    not DATASET_AVAILABLE,
    reason="nifty dataset not present (run scripts.convert_to_parquet first)",
)

# Fixed window + parameters the baselines were captured with.
START, END = "2025-01-02", "2025-01-10"
BASE_CONFIG = dict(
    entry_time="09:45",
    exit_time="15:15",
    expiry_selection="nearest",
    orb_minutes=15,
    orb_cutoff_time="13:30",
    iv_drop_threshold=0.001,
    required_anomalies=3,
    capital=1_000_000,
    lot_size=65,
    strike_step=50,
)

# Pinned outputs: run_mode -> (total_pnl, total_trades, total_days).
GOLDEN = {
    "COMBINED": (83017.95, 38, 7),
    "WALL_ONLY": (100458.61, 37, 7),
    "ORB_ONLY": (-4369.30, 7, 7),
}


def _run(**overrides) -> dict:
    """Run the fixed backtest and return the results payload."""
    config = StrategyConfig(**{**BASE_CONFIG, **overrides})
    bt = Backtester(
        str(OPTIONS_PATH), str(SPOT_PATH), config, start_date=START, end_date=END
    )
    tracker = bt.run(start_date=START, end_date=END)
    return tracker.build_results(initial_capital=BASE_CONFIG["capital"])


@pytest.mark.parametrize("mode", list(GOLDEN))
def test_golden_results(mode: str) -> None:
    """Each run mode reproduces its pinned PnL / trade / day counts exactly."""
    pnl, trades, days = GOLDEN[mode]
    summary = _run(run_mode=mode)["summary"]
    assert summary["total_days"] == days
    assert summary["total_trades"] == trades
    assert summary["total_pnl"] == pytest.approx(pnl, abs=0.01)


def test_new_exit_knobs_default_to_baseline() -> None:
    """The newly-surfaced exit knobs must default to the old hard-coded behaviour."""
    summary = _run(
        run_mode="COMBINED",
        take_profit_pct=0.0,   # disabled
        max_reentries=0,       # off
        max_hold_bars=45,
        stop_loss_pct=0.25,
        trailing_sl_pct=0.15,
    )["summary"]
    assert summary["total_pnl"] == pytest.approx(GOLDEN["COMBINED"][0], abs=0.01)


def test_tight_max_hold_changes_exits() -> None:
    """A tight max-hold should force most legs out via 'Time Decay Force Exit'."""
    result = _run(run_mode="COMBINED", max_hold_bars=5)
    reasons = [r["exit_reason"] for r in result["trade_log"]]
    forced = sum(r == "Time Decay Force Exit" for r in reasons)
    assert forced >= len(reasons) // 2  # the dominant exit reason now
    # ...and it actually changes the bottom line vs the 45-bar baseline.
    assert result["summary"]["total_pnl"] != pytest.approx(GOLDEN["COMBINED"][0], abs=0.01)
