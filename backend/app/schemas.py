"""Pydantic request/response schemas for the backtest API."""
from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .engine.config import StrategyConfig


# ── Requests ────────────────────────────────────────────────────────────────
class BacktestRequest(BaseModel):
    """Body for POST /api/backtest/start."""

    config: StrategyConfig = Field(default_factory=StrategyConfig)
    start_date: Optional[str] = Field(default=None, description="Inclusive ISO start date.")
    end_date: Optional[str] = Field(default=None, description="Inclusive ISO end date.")
    dataset: str = Field(default="nifty", min_length=1, description="Named dataset under DATA_DIR.")

    @field_validator("start_date", "end_date")
    @classmethod
    def _valid_iso_date(cls, v: Optional[str]) -> Optional[str]:
        """Ensure any provided date is a parseable ISO (YYYY-MM-DD) date."""
        if v in (None, ""):
            return None
        try:
            date.fromisoformat(v)
        except ValueError as exc:
            raise ValueError("must be an ISO date (YYYY-MM-DD)") from exc
        return v

    @model_validator(mode="after")
    def _check_date_order(self) -> "BacktestRequest":
        """Reject a start date that falls after the end date."""
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("start_date must be on or before end_date")
        return self


# ── Responses ───────────────────────────────────────────────────────────────
class StartResponse(BaseModel):
    """Returned when a backtest task is enqueued."""

    task_id: str
    status: str = "PENDING"


class ProgressInfo(BaseModel):
    """Progress detail for an in-flight task."""

    current: int
    total: int
    percent: float


class StatusResponse(BaseModel):
    """Task status payload for GET /api/backtest/status/{task_id}."""

    task_id: str
    status: str  # PENDING | PROGRESS | SUCCESS | FAILURE
    progress: Optional[ProgressInfo] = None
    error: Optional[str] = None


class EquityPoint(BaseModel):
    """One daily point on the equity / drawdown curve."""

    date: str
    pnl: float
    cumulative_pnl: float
    equity: float
    drawdown: float
    drawdown_pct: float


class TradeLogRow(BaseModel):
    """One leg execution in the trade log."""

    trade_id: int
    strategy: str
    date: str
    leg_id: str
    right: str
    strike: float
    direction: str
    expiry: str
    entry_time: Optional[str] = None
    exit_time: Optional[str] = None
    entry_premium: float
    exit_premium: float
    premium_change: float
    lots: int
    lot_size: int
    margin_blocked: float
    net_pnl_inr: float
    exit_reason: str


class BenchmarkPoint(BaseModel):
    """One point on the Nifty buy-and-hold benchmark curve."""

    date: str
    equity: float


class GreeksPoint(BaseModel):
    """Aggregate portfolio Greeks (and the underlying ref) for one trading day."""

    date: str
    delta: float
    gamma: float
    theta: float
    vega: float
    spot: float


class PresetCreate(BaseModel):
    """Body for POST /api/presets — save a named strategy configuration."""

    name: str = Field(min_length=1, max_length=80)
    config: Dict[str, Any]


class ResultsResponse(BaseModel):
    """Full results payload for GET /api/backtest/results/{task_id}."""

    task_id: str
    status: str
    symbol: str = "NIFTY"
    metrics: Dict[str, Any]
    summary: Dict[str, Any]
    equity_curve: List[EquityPoint]
    trade_log: List[TradeLogRow]
    benchmark: List[BenchmarkPoint] = []
    greeks: List[GreeksPoint] = []
