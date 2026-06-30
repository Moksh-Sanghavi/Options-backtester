"""
Lightweight SQLite persistence for backtest history and saved config presets.

Uses the stdlib ``sqlite3`` (no extra dependency). A single file under the data
directory holds two tables:

* ``runs``    — one row per completed backtest (config + full results payload).
* ``presets`` — named, reusable strategy configurations.

Both the API process and the Celery worker open the same file; WAL mode keeps
concurrent reads/writes safe on a single machine.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .config import settings

DB_PATH: Path = settings.data_dir / "backtester.db"


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection with rows as dicts and WAL enabled."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if they don't exist (idempotent)."""
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id          TEXT PRIMARY KEY,
                created_at  TEXT NOT NULL,
                label       TEXT,
                dataset     TEXT,
                start_date  TEXT,
                end_date    TEXT,
                run_mode    TEXT,
                strategy_type TEXT,
                total_pnl   REAL,
                total_trades INTEGER,
                total_days  INTEGER,
                config_json TEXT NOT NULL,
                results_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS presets (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                created_at  TEXT NOT NULL,
                config_json TEXT NOT NULL
            );
            """
        )
        # Migrate older databases that predate the ``strategy_type`` column.
        # ``run_mode`` only captures the Wall/ORB combination, so straddle runs
        # used to surface as "WALL_ONLY" in history; ``strategy_type`` carries
        # the human-readable strategy label instead.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)")}
        if "strategy_type" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN strategy_type TEXT")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _strategy_label(config: Dict[str, Any]) -> Optional[str]:
    """Human-readable label of the strategies a run actually executed.

    ``config.strategy_type`` is a single enum value and can't represent a
    combination, so we compose the label from the per-strategy enable flags —
    mirroring the engine's precedence (explicit flags override ``run_mode``;
    Short Straddle is governed solely by its own flag). Falls back to the stored
    ``strategy_type`` when no flag information is present.
    """
    mode = config.get("run_mode")
    wall = config.get("wall_enabled")
    if wall is None:
        wall = mode in ("WALL_ONLY", "COMBINED")
    orb = config.get("orb_enabled")
    if orb is None:
        orb = mode in ("ORB_ONLY", "COMBINED")

    parts: List[str] = []
    if wall:
        parts.append("Wall Reversion")
    if orb:
        parts.append("Opening Range Breakout")
    if config.get("straddle_enabled"):
        parts.append("Short Straddle")
    return " + ".join(parts) if parts else config.get("strategy_type")


# ── Runs ────────────────────────────────────────────────────────────────────
def save_run(run_id: str, request: Dict[str, Any], results: Dict[str, Any]) -> None:
    """Persist a completed backtest. ``request`` is the BacktestRequest payload."""
    summary = results.get("summary") or {}
    config = request.get("config") or {}
    label = (
        f"{request.get('dataset', '')} · "
        f"{request.get('start_date') or 'start'} → {request.get('end_date') or 'end'}"
    )
    with _connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO runs
              (id, created_at, label, dataset, start_date, end_date, run_mode,
               strategy_type, total_pnl, total_trades, total_days,
               config_json, results_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                run_id,
                _now(),
                label,
                request.get("dataset"),
                request.get("start_date"),
                request.get("end_date"),
                config.get("run_mode"),
                _strategy_label(config),
                summary.get("total_pnl"),
                summary.get("total_trades"),
                summary.get("total_days"),
                json.dumps(config),
                json.dumps(results),
            ),
        )


def list_runs(limit: int = 100) -> List[Dict[str, Any]]:
    """Recent runs (metadata only — no heavy results payload)."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, label, dataset, start_date, end_date, run_mode,
                   strategy_type, total_pnl, total_trades, total_days
            FROM runs ORDER BY created_at DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    """Full stored run including config and the complete results payload."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["config"] = json.loads(data.pop("config_json"))
    data["results"] = json.loads(data.pop("results_json"))
    return data


def delete_run(run_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
    return cur.rowcount > 0


# ── Presets ─────────────────────────────────────────────────────────────────
def save_preset(name: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """Create or overwrite a named config preset; returns its metadata."""
    preset_id = str(uuid.uuid4())
    created = _now()
    with _connect() as conn:
        existing = conn.execute("SELECT id FROM presets WHERE name = ?", (name,)).fetchone()
        if existing:
            preset_id = existing["id"]
            conn.execute(
                "UPDATE presets SET config_json = ?, created_at = ? WHERE id = ?",
                (json.dumps(config), created, preset_id),
            )
        else:
            conn.execute(
                "INSERT INTO presets (id, name, created_at, config_json) VALUES (?,?,?,?)",
                (preset_id, name, created, json.dumps(config)),
            )
    return {"id": preset_id, "name": name, "created_at": created}


def list_presets() -> List[Dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at, config_json FROM presets ORDER BY name ASC"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["config"] = json.loads(d.pop("config_json"))
        out.append(d)
    return out


def delete_preset(preset_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))
    return cur.rowcount > 0
