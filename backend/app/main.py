"""
FastAPI application exposing the asynchronous backtest API.

Routes:
    GET  /api/health                       — liveness probe
    GET  /api/datasets                     — available Parquet datasets
    POST /api/backtest/start               — enqueue a backtest, return task_id
    GET  /api/backtest/status/{task_id}    — poll task status / progress
    GET  /api/backtest/results/{task_id}   — fetch completed results
"""
from __future__ import annotations

import logging

import pandas as pd
from celery.result import AsyncResult
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import db
from .celery_app import celery
from .config import settings
from .engine.data_manager import select_expiry_partitions
from .schemas import (
    BacktestRequest,
    PresetCreate,
    ResultsResponse,
    StartResponse,
    StatusResponse,
)
from .tasks import run_backtest

db.init_db()

logger = logging.getLogger("OptionsBacktester.API")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

app = FastAPI(
    title="Nifty Options Backtester API",
    version="1.0.0",
    description="Asynchronous backtesting service for Wall Reversion + ORB strategies.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Flatten Pydantic validation errors into a single readable message."""
    parts = []
    for err in exc.errors():
        loc = " → ".join(str(p) for p in err.get("loc", []) if p != "body")
        parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
    return JSONResponse(status_code=422, content={"detail": "; ".join(parts)})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all so unexpected server errors return JSON, not an HTML 500."""
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500, content={"detail": "Internal server error. Please try again."}
    )


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Liveness probe."""
    return {"status": "ok"}


@app.get("/api/datasets", tags=["meta"])
def list_datasets() -> dict:
    """List dataset names that have both options and spot data.

    Options may be either a single ``options_<name>.parquet`` file (legacy) or a
    partitioned ``options_<name>/`` directory (multi-year); both are reported.
    """
    data_dir = settings.data_dir
    if not data_dir.exists():
        return {"datasets": []}
    option_files = {p.stem.removeprefix("options_") for p in data_dir.glob("options_*.parquet")}
    option_dirs = {
        p.name.removeprefix("options_") for p in data_dir.glob("options_*") if p.is_dir()
    }
    options = option_files | option_dirs
    spots = {p.stem.removeprefix("spot_") for p in data_dir.glob("spot_*.parquet")}
    return {"datasets": sorted(options & spots)}


@app.get("/api/datasets/{dataset}/expiries", tags=["meta"])
def dataset_expiries(
    dataset: str, start: str | None = None, end: str | None = None
) -> dict:
    """Expiries available for a (partitioned) dataset, optionally within a range.

    Powers the frontend "Target Expiry" dropdown: when ``start``/``end`` are
    supplied, returns the contiguous block of monthly expiries the engine could
    actually trade over that range (the same set the loader would read). Reads
    only partition directory names — no market data is loaded.
    """
    all_expiries = [pd.Timestamp(e) for e in settings.dataset_expiries(dataset)]
    if start or end:
        selected = select_expiry_partitions(all_expiries, start, end)
    else:
        selected = all_expiries
    return {
        "dataset": dataset,
        "expiries": [e.strftime("%Y-%m-%d") for e in selected],
    }


@app.post("/api/backtest/start", response_model=StartResponse, tags=["backtest"])
def start_backtest(request: BacktestRequest) -> StartResponse:
    """Validate the config, enqueue the Celery task, and return its id."""
    options_path, spot_path = settings.dataset_paths(request.dataset)
    if not options_path.exists() or not spot_path.exists():
        raise HTTPException(
            status_code=404,
            detail=(
                f"Dataset '{request.dataset}' not found. Expected "
                f"{options_path.name} and {spot_path.name} in {settings.data_dir}."
            ),
        )

    task = run_backtest.delay(request.model_dump(mode="json"))
    return StartResponse(task_id=task.id, status="PENDING")


@app.get("/api/backtest/status/{task_id}", response_model=StatusResponse, tags=["backtest"])
def backtest_status(task_id: str) -> StatusResponse:
    """Report the current state (and progress) of a backtest task."""
    result = AsyncResult(task_id, app=celery)
    state = result.state

    response = StatusResponse(task_id=task_id, status=state)

    if state == "PROGRESS" and isinstance(result.info, dict):
        response.progress = {
            "current": result.info.get("current", 0),
            "total": result.info.get("total", 0),
            "percent": result.info.get("percent", 0.0),
        }
    elif state == "FAILURE":
        response.error = str(result.info)

    return response


@app.get("/api/backtest/results/{task_id}", response_model=ResultsResponse, tags=["backtest"])
def backtest_results(task_id: str) -> ResultsResponse:
    """Return completed results, or an error if the task isn't done."""
    result = AsyncResult(task_id, app=celery)
    state = result.state

    if state == "FAILURE":
        raise HTTPException(status_code=500, detail=str(result.info))
    if state != "SUCCESS":
        raise HTTPException(
            status_code=409, detail=f"Results not ready (task state: {state})."
        )

    data = result.result
    return ResultsResponse(
        task_id=task_id,
        status=state,
        symbol=data.get("symbol", "NIFTY"),
        metrics=data.get("metrics", {}),
        summary=data.get("summary", {}),
        equity_curve=data.get("equity_curve", []),
        trade_log=data.get("trade_log", []),
        benchmark=data.get("benchmark", []),
        greeks=data.get("greeks", []),
    )


@app.get("/api/backtest/greeks/{task_id}", tags=["backtest"])
def backtest_greeks(task_id: str) -> dict:
    """Daily portfolio Greeks time-series for a completed backtest.

    Returns ``{"task_id", "greeks": [{date, delta, gamma, theta, vega, spot}, ...]}``.
    The same array is included in the full results payload; this lighter endpoint
    lets the Greeks visualization refresh independently of the rest of the sheet.
    """
    result = AsyncResult(task_id, app=celery)
    state = result.state

    if state == "FAILURE":
        raise HTTPException(status_code=500, detail=str(result.info))
    if state != "SUCCESS":
        raise HTTPException(
            status_code=409, detail=f"Results not ready (task state: {state})."
        )

    data = result.result
    return {"task_id": task_id, "greeks": data.get("greeks", [])}


# ── History (persisted runs) ────────────────────────────────────────────────
@app.get("/api/history", tags=["history"])
def list_history() -> dict:
    """List recent completed backtests (metadata only)."""
    return {"runs": db.list_runs()}


@app.get("/api/history/{run_id}", tags=["history"])
def get_history(run_id: str) -> dict:
    """Full stored run (config + complete results payload) for reopening."""
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found.")
    return run


@app.delete("/api/history/{run_id}", tags=["history"])
def delete_history(run_id: str) -> dict:
    """Delete a stored run."""
    if not db.delete_run(run_id):
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found.")
    return {"deleted": run_id}


# ── Config presets ──────────────────────────────────────────────────────────
@app.get("/api/presets", tags=["presets"])
def list_presets() -> dict:
    """List saved strategy-configuration presets."""
    return {"presets": db.list_presets()}


@app.post("/api/presets", tags=["presets"])
def create_preset(preset: PresetCreate) -> dict:
    """Save (or overwrite by name) a strategy-configuration preset."""
    return db.save_preset(preset.name, preset.config)


@app.delete("/api/presets/{preset_id}", tags=["presets"])
def delete_preset(preset_id: str) -> dict:
    """Delete a saved preset."""
    if not db.delete_preset(preset_id):
        raise HTTPException(status_code=404, detail=f"Preset '{preset_id}' not found.")
    return {"deleted": preset_id}
