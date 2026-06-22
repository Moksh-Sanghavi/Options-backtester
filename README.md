# 📈 Nifty Options Backtester

A full-stack web application for backtesting **Nifty 50 options strategies** — wrapping a production-grade quant engine in an asynchronous API and a premium, interactive dashboard.

<p align="center">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?logo=next.js">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white">
  <img alt="Celery" src="https://img.shields.io/badge/Celery-Redis-37814A?logo=celery&logoColor=white">
  <img alt="D3.js" src="https://img.shields.io/badge/D3.js-charts-F9A03C?logo=d3.js&logoColor=white">
</p>

---

## ✨ Features

- **Two built-in strategies**
  - **Wall Reversion** — detects implied-volatility anomalies across the option chain and trades reversions.
  - **Opening Range Breakout (ORB)** — breakout entries with asymmetric, trend-aware position sizing.
  - Run either alone or **combined**, with configurable capital, risk-per-trade, IV thresholds, and session timing.
- **Asynchronous backtesting** — runs are queued to a Celery worker so the UI stays responsive, with **live "processing day N of M" progress**.
- **Interactive Charts Explorer (D3.js)** — switch between **Equity Curve**, **Max Drawdown**, and **Spot Price Candlestick** views on one synchronized daily axis, with rich tooltips, a crosshair, and peak-drawdown markers.
- **Full performance tear sheet** — 8 headline metrics (Total PnL, ROI, Max DD, Sharpe, win rates, profit factor) plus a paginated trade log with CE/PE and win/loss cues.
- **Premium dark UI** — frosted-glass "terminal" aesthetic with realistic depth and light diffusion.
- **Robust error handling** — readable validation errors, missing-dataset and empty-result states, all surfaced cleanly in the UI.
- **One-command launch** on Windows *and* macOS, plus a Docker path.

---

## 🧱 Tech stack

| Layer          | Technology                                                            |
|----------------|----------------------------------------------------------------------|
| Frontend       | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui, **D3.js** |
| Backend        | FastAPI, Pydantic                                                    |
| Async compute  | Celery + Redis                                                       |
| Data / quant   | Pandas, NumPy, SciPy, PyArrow (Parquet)                              |
| Tooling        | Docker, Docker Compose                                               |

---

## 🏗️ Architecture

```
Browser ──HTTP──> FastAPI (API) ──enqueue──> Redis ──> Celery worker
   ▲                  │                                     │
   └──── poll status ─┘                                     │ runs the engine
                      └──────── results stored in Redis <───┘
```

The browser talks only to the Next.js server, which proxies `/api/*` to FastAPI — so a single origin serves the whole app (no CORS setup needed).

---

## 🚀 Quick start

### Prerequisites
- **Python** 3.12+ (tested on 3.14)
- **Node.js** 20+ (tested on 24)
- **Redis** 5+

### 1. Clone
```bash
git clone https://github.com/<your-username>/nifty-options-backtester.git
cd nifty-options-backtester
```
> ✅ A sample dataset (`backend/data/*.parquet`, Dec 2023) is included, so you can run immediately after installing dependencies — no data prep required.

### 2. Install dependencies
```bash
# Backend (Python)
cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate     |   macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
cd ..

# Frontend (Node)
cd frontend
npm install
cd ..
```

### 3. Run

**One command (recommended):**

| OS | Command |
|----|---------|
| **Windows** | `powershell -ExecutionPolicy Bypass -File start-all.ps1` (or double-click the desktop shortcut) |
| **macOS**   | `./start-mac.command` (first time: `chmod +x start-mac.command stop-mac.command`) |

This starts Redis, the API, the Celery worker, and the frontend, then opens the app. Stop everything with `stop-all.ps1` / `./stop-mac.command`.

**Or start each service manually** (4 terminals):
```bash
# 1. Redis
redis-server

# 2. FastAPI  (activate the venv first)
uvicorn app.main:app --reload --app-dir backend --host 0.0.0.0 --port 8000

# 3. Celery worker  (from backend/, venv active)
celery -A app.celery_app.celery worker --loglevel=info --pool=solo

# 4. Frontend
cd frontend && npm run dev
```
> `--pool=solo` is required for Celery on Windows (the default prefork pool isn't supported there).

- 🖥️ App: **http://localhost:3000**
- 📚 API docs: **http://localhost:8000/docs**

### Or with Docker
```bash
docker compose up --build
```
Brings up Redis, API, worker, and frontend together (waits on healthchecks). Requires Docker Desktop.

---

## 📂 Project structure

```
backend/
  app/
    engine/        # the quant engine: strategy, execution, analytics, data, IV, costs
    main.py        # FastAPI routes
    tasks.py       # Celery task wrapping a backtest run
    celery_app.py  # Celery + Redis config
    schemas.py     # API request/response models
  scripts/
    convert_to_parquet.py   # CSV → Parquet converter
  data/            # Parquet datasets (included)
frontend/
  src/
    components/    # dashboard, config panel, charts-explorer (D3), tear sheet, trade log
    hooks/         # backtest run/poll state machine
    lib/           # typed API client, formatters, chart data
start-all.ps1 / stop-all.ps1        # one-command launch (Windows)
start-mac.command / stop-mac.command # one-command launch (macOS)
```

---

## 🔧 Extending it

Adding a new dataset or a new strategy is documented step-by-step in
**[extending_the_backtester_guide.md](extending_the_backtester_guide.md)**:

- **New data** is essentially drop-in — run the converter with a new `--dataset` name and it auto-appears in the UI.
- **New strategies** are a contained code change; the entire results pipeline (charts, metrics, trade log) is strategy-agnostic and works automatically once your strategy emits trades.

Per-OS run details: **[nifty_backtester_run_guide.md](nifty_backtester_run_guide.md)** (Windows) · **[mac_run_guide.md](mac_run_guide.md)** (macOS).

---

## 📝 Notes

- Transaction costs (brokerage, STT, exchange, GST, stamp duty) are modeled per NSE/NFO rates in `backend/app/engine/constants.py`.
- Backtest runtime scales roughly linearly with the number of trading days; the worker runs single-threaded (`--pool=solo`).
- The included data is a sample for demonstration; swap in your own via the converter.

---

<p align="center"><sub>Built with FastAPI · Celery · Next.js · D3.js</sub></p>
