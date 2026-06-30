"""
Data layer: loads, cleans, indexes and serves options + spot market data.

`DataManager` reads **Parquet** by default (substantially faster than CSV) but
transparently falls back to CSV when given a ``.csv`` path. The cleaning
routines are exposed at module level so the CSV→Parquet converter and the
manager share identical logic.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .constants import MARKET_CLOSE, MARKET_OPEN

logger = logging.getLogger("OptionsBacktester.DataManager")

# Market session as Timedeltas (for building intraday minute grids).
_OPEN_TD = pd.Timedelta(hours=MARKET_OPEN.hour, minutes=MARKET_OPEN.minute)
_CLOSE_TD = pd.Timedelta(hours=MARKET_CLOSE.hour, minutes=MARKET_CLOSE.minute)

# Matches the YYYY-MM-DD in a partition directory name like ``expiry=2023-12-28``.
_PARTITION_RE = re.compile(r"expiry=(\d{4}-\d{2}-\d{2})")


# ── Shared cleaning routines ────────────────────────────────────────────────
def clean_options_frame(df: pd.DataFrame, stock_code: str = "NIFTY") -> pd.DataFrame:
    """Normalise, type, filter and sort a raw options frame.

    Applies the same transformations the original engine performed on load:
    lower-cased columns, parsed datetimes, capitalised right, stock-code filter,
    NaN/zero-price removal, market-hours window, and chronological sort.
    """
    df = df.copy()
    df.columns = df.columns.str.strip().str.lower().str.replace(" ", "_")
    df["datetime"] = pd.to_datetime(df["datetime"]).dt.floor("min")
    df["expiry_date"] = pd.to_datetime(df["expiry_date"], dayfirst=True)
    df["right"] = df["right"].astype(str).str.strip().str.capitalize()

    df = df[df["stock_code"].astype(str).str.upper() == stock_code.upper()].copy()
    df.dropna(subset=["datetime", "strike_price", "close"], inplace=True)
    df = df[df["close"] > 0]
    df = df[(df["datetime"].dt.time >= MARKET_OPEN) & (df["datetime"].dt.time <= MARKET_CLOSE)]

    df.sort_values("datetime", inplace=True)
    df.drop_duplicates(subset=["datetime", "expiry_date", "right", "strike_price"], keep="last", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df


def clean_spot_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise, filter and sort a raw spot frame."""
    df = df.copy()
    df.columns = df.columns.str.strip().str.lower().str.replace(" ", "_")
    df["datetime"] = pd.to_datetime(df["datetime"]).dt.floor("min")
    df.dropna(subset=["datetime", "close"], inplace=True)
    df = df[df["close"] > 0]
    df = df[(df["datetime"].dt.time >= MARKET_OPEN) & (df["datetime"].dt.time <= MARKET_CLOSE)]
    df.sort_values("datetime", inplace=True)
    df.drop_duplicates(subset=["datetime"], keep="last", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df


def align_spot_to_minutes(df: pd.DataFrame) -> pd.DataFrame:
    """Reindex spot onto a complete per-session minute grid, forward-filling gaps.

    The options feed often has minutes the spot feed is missing (and vice-versa).
    To guarantee every option timestamp has a spot reference, we build the full
    09:15→15:30 one-minute grid for each trading day and reindex the (already
    cleaned) spot frame onto it. Price columns and ``atm_strike`` are forward
    filled from the last known bar; ``volume`` fills with 0. Leading minutes with
    no prior bar to carry forward are dropped.

    Expects the output of :func:`clean_spot_frame` (datetime floored to the
    minute, within market hours, sorted).
    """
    if df.empty:
        return df

    df = df.copy()
    ffill_cols = [c for c in ("open", "high", "low", "close", "atm_strike") if c in df.columns]
    days = df["datetime"].dt.normalize()

    pieces: List[pd.DataFrame] = []
    for day, grp in df.groupby(days, sort=True):
        grid = pd.date_range(day + _OPEN_TD, day + _CLOSE_TD, freq="min")
        grp = grp.set_index("datetime").reindex(grid)
        grp[ffill_cols] = grp[ffill_cols].ffill()
        if "volume" in grp.columns:
            grp["volume"] = grp["volume"].fillna(0)
        grp = grp.reset_index(names="datetime")
        pieces.append(grp)

    out = pd.concat(pieces, ignore_index=True)
    out.dropna(subset=["close"], inplace=True)  # drop un-fillable leading minutes
    out.sort_values("datetime", inplace=True)
    out.reset_index(drop=True, inplace=True)
    return out


def select_expiry_partitions(
    expiries: List[pd.Timestamp],
    start_date: Optional[str | pd.Timestamp],
    end_date: Optional[str | pd.Timestamp],
) -> List[pd.Timestamp]:
    """Return the minimal contiguous set of expiries needed for a date range.

    With monthly-expiry partitions, each trading day trades its *nearest* expiry
    (the first expiry on/after that day). ``nearest_expiry`` is monotonic in the
    day, so the expiries needed for ``[start, end]`` form a contiguous block:
    from the first expiry ≥ start to the first expiry ≥ end (inclusive). This
    lets the loader read only the relevant partitions instead of three years of
    options data.
    """
    expiries = sorted(expiries)
    if not expiries:
        return []
    last = len(expiries) - 1

    def first_ge(ts: pd.Timestamp) -> int:
        for i, e in enumerate(expiries):
            if e >= ts:
                return i
        return last  # range extends past the last expiry → clamp to it

    lo = first_ge(pd.Timestamp(start_date)) if start_date else 0
    hi = first_ge(pd.Timestamp(end_date)) if end_date else last
    if lo > hi:
        lo = hi
    return expiries[lo : hi + 1]


class DataManager:
    """Loads, validates, cleans, and indexes options + spot data."""

    def __init__(
        self,
        options_path: str,
        spot_path: str,
        stock_code: str = "NIFTY",
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> None:
        self.options_path = Path(options_path)
        self.spot_path = Path(spot_path)
        self.stock_code = stock_code.upper()
        # Date range bounds the partitions loaded for a partitioned dataset, so
        # multi-year data never has to be read into RAM all at once.
        self.start_date = start_date
        self.end_date = end_date

        self.options_df: pd.DataFrame = pd.DataFrame()
        self.spot_df: pd.DataFrame = pd.DataFrame()

        logger.info("DataManager initialising. Loading data...")
        self._load_and_clean()
        logger.info(
            f"Loaded {len(self.options_df):,} option rows and {len(self.spot_df):,} spot rows."
        )

    # ── Loading ─────────────────────────────────────────────────────────────
    @staticmethod
    def _read(path: Path) -> pd.DataFrame:
        """Read a frame from Parquet or CSV based on file suffix."""
        if path.suffix.lower() == ".parquet":
            return pd.read_parquet(path)
        return pd.read_csv(path, low_memory=False)

    def _partition_expiries(self) -> List[pd.Timestamp]:
        """All expiry dates available as partitions under a partitioned dir."""
        out: List[pd.Timestamp] = []
        for child in self.options_path.glob("expiry=*"):
            m = _PARTITION_RE.search(child.name)
            if child.is_dir() and m:
                out.append(pd.Timestamp(m.group(1)))
        return sorted(out)

    def _load_partitioned_options(self) -> pd.DataFrame:
        """Load only the expiry partitions overlapping the requested date range.

        Each ``expiry=YYYY-MM-DD/`` partition holds already-cleaned Parquet, so
        we concatenate the selected partitions and skip re-cleaning.
        """
        all_expiries = self._partition_expiries()
        if not all_expiries:
            raise FileNotFoundError(
                f"No expiry partitions found under {self.options_path}. "
                "Run the Parquet converter first."
            )
        selected = select_expiry_partitions(all_expiries, self.start_date, self.end_date)
        logger.info(
            f"Partitioned dataset: loading {len(selected)} of {len(all_expiries)} "
            f"expiry partitions for range {self.start_date or 'start'} → "
            f"{self.end_date or 'end'}."
        )

        frames: List[pd.DataFrame] = []
        for expiry in selected:
            part = self.options_path / f"expiry={expiry.strftime('%Y-%m-%d')}" / "data.parquet"
            if part.exists():
                frames.append(pd.read_parquet(part))
            else:
                logger.warning(f"Missing partition file: {part}")
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True)

    def _load_and_clean(self) -> None:
        if not self.options_path.exists():
            raise FileNotFoundError(f"Options data not found: {self.options_path}")
        if not self.spot_path.exists():
            raise FileNotFoundError(f"Spot data not found: {self.spot_path}")

        logger.info(f"Reading options data: {self.options_path}")
        if self.options_path.is_dir():
            # Partitioned multi-year dataset — load only the needed expiries.
            opts = self._load_partitioned_options()
        else:
            opts = self._read(self.options_path)
            # Parquet produced by our converter is already cleaned; CSV is raw.
            if self.options_path.suffix.lower() != ".parquet":
                opts = clean_options_frame(opts, self.stock_code)
        self.options_df = opts

        logger.info(f"Reading spot data: {self.spot_path}")
        spot = self._read(self.spot_path)
        if self.spot_path.suffix.lower() != ".parquet":
            spot = align_spot_to_minutes(clean_spot_frame(spot))
        self.spot_df = spot

        if self.options_df.empty:
            raise ValueError("Options dataset is empty after cleaning.")
        if self.spot_df.empty:
            raise ValueError("Spot dataset is empty after cleaning.")

        self._build_option_index()

    @staticmethod
    def _contract_key(
        date: pd.Timestamp, expiry: pd.Timestamp, right: str, strike: float
    ) -> Tuple[int, int, str, float]:
        """Canonical, hashable contract key. The date is normalised to midnight
        so a per-minute ``timestamp`` maps to its trading day; datetimes are
        int64 ns to avoid Timestamp/datetime64 mismatches across pandas versions."""
        return (
            pd.Timestamp(date).normalize().value,
            pd.Timestamp(expiry).value,
            right.capitalize(),
            float(strike),
        )

    def _build_option_index(self) -> None:
        """Index options for O(1) per-contract access without a second full copy.

        Rows are sorted so every contract's bars are contiguous and time-ordered;
        we then keep just numpy column views plus a ``key -> (start, end)`` map.
        This replaces the old multi-index *copy* (which doubled memory) and turns
        per-minute price lookups from pandas ``.loc`` into a dict hit + a numpy
        ``searchsorted`` — far faster and roughly half the RAM.
        """
        df = self.options_df
        df["date"] = df["datetime"].dt.normalize()
        df.sort_values(
            ["date", "expiry_date", "right", "strike_price", "datetime"],
            kind="stable",
            inplace=True,
        )
        df.reset_index(drop=True, inplace=True)
        self.options_df = df

        # Column arrays for positional access (views into the frame, no copy).
        self._dt: np.ndarray = df["datetime"].to_numpy()
        self._open: np.ndarray = df["open"].to_numpy(dtype="float64")
        self._close: np.ndarray = df["close"].to_numpy(dtype="float64")

        # contract key -> (start, end) row span (contiguous after the sort).
        groups = df.groupby(
            ["date", "expiry_date", "right", "strike_price"], sort=False
        ).indices
        self._contract_pos: Dict[Tuple[int, int, str, float], Tuple[int, int]] = {
            self._contract_key(k[0], k[1], k[2], k[3]): (int(v[0]), int(v[-1]) + 1)
            for k, v in groups.items()
        }

        # date (int64 ns) -> sorted unique expiries available that day.
        self._expiries_by_date: Dict[int, List[pd.Timestamp]] = {
            pd.Timestamp(d).value: sorted(g.unique().tolist())
            for d, g in df.groupby("date")["expiry_date"]
        }
        logger.info("Option index built (%d contracts).", len(self._contract_pos))

    # ── Query API ───────────────────────────────────────────────────────────
    def get_spot_price(self, timestamp: pd.Timestamp) -> float:
        """Last known spot close at or before ``timestamp``."""
        idx = self.spot_df["datetime"].searchsorted(timestamp, side="right") - 1
        if idx < 0:
            raise ValueError(f"No spot data before {timestamp}")
        return float(self.spot_df.iloc[idx]["close"])

    def get_spot_ema(self, timestamp: pd.Timestamp, period: int = 20) -> float:
        """Intraday EMA of spot close up to ``timestamp`` (since session open)."""
        date = timestamp.normalize()
        mask = (self.spot_df["datetime"] >= date) & (self.spot_df["datetime"] <= timestamp)
        morning_data = self.spot_df[mask]

        if len(morning_data) < period:
            return float(morning_data["close"].iloc[-1]) if not morning_data.empty else 0.0

        ema = morning_data["close"].ewm(span=period, adjust=False).mean()
        return float(ema.iloc[-1])

    def get_option_price(
        self,
        timestamp: pd.Timestamp,
        expiry_date: pd.Timestamp,
        right: str,
        strike: float,
        price_col: str = "open",
    ) -> Optional[float]:
        """Price for a contract at ``timestamp``.

        Uses ``price_col`` on an exact-minute match, otherwise the last known
        close. Returns None when the contract has no data up to that time.
        """
        span = self._contract_pos.get(
            self._contract_key(timestamp, expiry_date, right, strike)
        )
        if span is None:
            return None

        start, end = span
        ts64 = timestamp.to_datetime64()
        dts = self._dt[start:end]
        pos = int(dts.searchsorted(ts64, side="right")) - 1
        if pos < 0:
            return None  # no bar at or before this timestamp

        abs_pos = start + pos
        is_exact_match = dts[pos] == ts64
        if is_exact_match and price_col == "open":
            return float(self._open[abs_pos])
        # Non-exact (carry last close) or an explicit close request.
        return float(self._close[abs_pos])

    def get_option_timeseries(
        self,
        date: pd.Timestamp,
        expiry_date: pd.Timestamp,
        right: str,
        strike: float,
    ) -> pd.DataFrame:
        """Full intraday OHLCV series for a single contract on ``date``."""
        span = self._contract_pos.get(self._contract_key(date, expiry_date, right, strike))
        if span is None:
            return self.options_df.iloc[0:0]
        start, end = span
        return self.options_df.iloc[start:end]

    def get_available_expiries(self, date: pd.Timestamp) -> List[pd.Timestamp]:
        """Sorted unique expiries available on ``date``."""
        return self._expiries_by_date.get(pd.Timestamp(date).value, [])

    def get_available_strikes(
        self,
        date: pd.Timestamp,
        expiry_date: pd.Timestamp,
        right: str,
    ) -> List[float]:
        """Sorted unique strikes for a right/expiry on ``date``."""
        mask = (
            (self.options_df["date"] == date)
            & (self.options_df["expiry_date"] == expiry_date)
            & (self.options_df["right"] == right.capitalize())
        )
        return sorted(self.options_df[mask]["strike_price"].unique().tolist())

    def trading_dates(self) -> List[pd.Timestamp]:
        """All trading dates present in the options dataset."""
        return sorted(self.options_df["date"].unique().tolist())
