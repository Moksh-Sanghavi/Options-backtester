"""
CSV → Parquet converter.

Supports two layouts:

* **Multi-year (partitioned)** — point ``--options`` at the directory of
  per-expiry CSVs (``NIFTY_<expiry>.csv``). Each file is cleaned and written to
  its own partition ``options_<dataset>/expiry=YYYY-MM-DD/data.parquet``. Files
  are processed one at a time so the full multi-GB dataset is never held in RAM.
  The spot CSV is cleaned, gap-filled onto a complete per-minute session grid
  (see ``align_spot_to_minutes``) and written to ``spot_<dataset>.parquet``.

* **Single file (legacy)** — point ``--options`` at one CSV; it is written to
  ``options_<dataset>.parquet`` and the spot to ``spot_<dataset>.parquet``.

Run from the ``backend`` directory. With no arguments it converts the bundled
multi-year dataset into ``data/options_nifty/`` + ``data/spot_nifty.parquet``:

    python -m scripts.convert_to_parquet

Or explicitly:

    python -m scripts.convert_to_parquet \
        --options "../Options Data (Monthly Expiries from Jan 2023 - Feb 2026)" \
        --spot    "../Spot (Jan 2023 - Feb 2026).csv" \
        --dataset nifty
"""
from __future__ import annotations

import argparse
import re
import time
from pathlib import Path

import pandas as pd

from app.config import settings
from app.engine.data_manager import (
    align_spot_to_minutes,
    clean_options_frame,
    clean_spot_frame,
)

# Defaults point at the bundled multi-year dataset (one CSV per monthly expiry).
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_OPTIONS = PROJECT_ROOT / "Options Data (Monthly Expiries from Jan 2023 - Feb 2026)"
DEFAULT_SPOT = PROJECT_ROOT / "Spot (Jan 2023 - Feb 2026).csv"
DEFAULT_DATASET = "nifty"

_EXPIRY_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _expiry_from_filename(path: Path) -> str:
    """Extract the YYYY-MM-DD expiry encoded in a file name like NIFTY_2023-12-28.csv."""
    m = _EXPIRY_RE.search(path.stem)
    if not m:
        raise ValueError(f"Cannot parse an expiry date from filename: {path.name}")
    return m.group(1)


def _convert_options_file(csv_path: Path, parquet_path: Path, stock_code: str) -> tuple[int, int]:
    """Clean one options CSV and write it to a single Parquet file."""
    df = pd.read_csv(csv_path, low_memory=False)
    raw_rows = len(df)
    df = clean_options_frame(df, stock_code)
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(parquet_path, engine="pyarrow", compression="snappy", index=False)
    return raw_rows, len(df)


def _convert_options_dir(options_dir: Path, out_root: Path, dataset: str, stock_code: str) -> None:
    """Convert a directory of per-expiry CSVs into a partitioned Parquet dataset.

    Streams one CSV at a time → one ``expiry=<date>/data.parquet`` partition,
    so memory stays bounded by the largest single expiry file.
    """
    files = sorted(options_dir.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No CSV files found in {options_dir}")

    print(f"Converting {len(files)} expiry files -> partitioned dataset 'options_{dataset}'")
    for i, csv_path in enumerate(files, start=1):
        expiry = _expiry_from_filename(csv_path)
        out_path = out_root / f"options_{dataset}" / f"expiry={expiry}" / "data.parquet"
        t0 = time.perf_counter()
        raw_rows, clean_rows = _convert_options_file(csv_path, out_path, stock_code)
        dt = time.perf_counter() - t0
        print(
            f"  [{i:>2}/{len(files)}] expiry={expiry}: "
            f"{raw_rows:,} raw -> {clean_rows:,} clean rows "
            f"({out_path.stat().st_size / 1e6:.1f} MB, {dt:.1f}s)"
        )


def _convert_spot(csv_path: Path, parquet_path: Path, *, align: bool) -> None:
    """Clean (and optionally minute-align) a spot CSV → Parquet."""
    t0 = time.perf_counter()
    print(f"Reading spot {csv_path} ...")
    df = pd.read_csv(csv_path, low_memory=False)
    raw_rows = len(df)
    df = clean_spot_frame(df)
    if align:
        df = align_spot_to_minutes(df)
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(parquet_path, engine="pyarrow", compression="snappy", index=False)
    dt = time.perf_counter() - t0
    print(
        f"  -> {parquet_path}  ({raw_rows:,} raw -> {len(df):,} "
        f"{'aligned' if align else 'clean'} rows, "
        f"{parquet_path.stat().st_size / 1e6:.1f} MB, {dt:.1f}s)"
    )


def main() -> None:
    """Parse arguments and convert the options + spot datasets."""
    parser = argparse.ArgumentParser(description="Convert options/spot CSVs to Parquet.")
    parser.add_argument(
        "--options",
        type=Path,
        default=DEFAULT_OPTIONS,
        help="Options CSV file (legacy) or directory of per-expiry CSVs (multi-year).",
    )
    parser.add_argument("--spot", type=Path, default=DEFAULT_SPOT, help="Spot CSV path.")
    parser.add_argument("--dataset", default=DEFAULT_DATASET, help="Dataset name (output suffix).")
    parser.add_argument("--out-dir", type=Path, default=settings.data_dir, help="Output dir.")
    parser.add_argument("--stock-code", default="NIFTY", help="Stock code to filter options.")
    args = parser.parse_args()

    spot_out = args.out_dir / f"spot_{args.dataset}.parquet"

    if args.options.is_dir():
        # Multi-year: partitioned options + minute-aligned spot.
        _convert_options_dir(args.options, args.out_dir, args.dataset, args.stock_code)
        _convert_spot(args.spot, spot_out, align=True)
    else:
        # Legacy single-file dataset.
        options_out = args.out_dir / f"options_{args.dataset}.parquet"
        t0 = time.perf_counter()
        print(f"Reading options {args.options} ...")
        raw_rows, clean_rows = _convert_options_file(args.options, options_out, args.stock_code)
        print(
            f"  -> {options_out}  ({raw_rows:,} raw -> {clean_rows:,} clean rows, "
            f"{options_out.stat().st_size / 1e6:.1f} MB, {time.perf_counter() - t0:.1f}s)"
        )
        _convert_spot(args.spot, spot_out, align=False)

    print(f"\nDone. Dataset '{args.dataset}' written to {args.out_dir}")


if __name__ == "__main__":
    main()
