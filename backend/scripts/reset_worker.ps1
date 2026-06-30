<#
.SYNOPSIS
    Reset the backtester's Celery worker to a clean slate.

.DESCRIPTION
    Clears BOTH queued tasks and the currently running one, in the correct order:

      1. Stop the Celery worker process tree  -> terminates the in-flight task
         (a running backtest cannot be cancelled any other way; `celery purge`
         only drops tasks that haven't started).
      2. Purge the Redis broker               -> deletes the 'celery' queue plus
         the 'unacked'/'unacked_index' records, so the killed task is NOT
         redelivered to the new worker.
      3. Restart a fresh --pool=solo worker   -> also reloads backend code
         (the worker does not hot-reload), unless -StopOnly is given.
      4. Verify with scripts\queue_status.py.

    Redis and the FastAPI/uvicorn server are left untouched.

.PARAMETER StopOnly
    Stop + purge but do NOT start a new worker.

.PARAMETER Loglevel
    Worker log level for the restart (default: info).

.EXAMPLE
    .venv\Scripts\python.exe is used internally; just run:
    powershell -ExecutionPolicy Bypass -File scripts\reset_worker.ps1
#>
[CmdletBinding()]
param(
    [switch]$StopOnly,
    [string]$Loglevel = "info"
)

$ErrorActionPreference = "Stop"

# Resolve paths relative to this script so it works from any CWD.
$BackendDir = Split-Path $PSScriptRoot -Parent
$Py        = Join-Path $BackendDir ".venv\Scripts\python.exe"
$CeleryExe = Join-Path $BackendDir ".venv\Scripts\celery.exe"
$StatusPy  = Join-Path $PSScriptRoot "queue_status.py"
$PurgePy   = Join-Path $PSScriptRoot "purge_broker.py"

if (-not (Test-Path $Py))        { throw "venv python not found at $Py" }
if (-not (Test-Path $CeleryExe)) { throw "celery.exe not found at $CeleryExe" }

# Only touch worker processes belonging to THIS backend (matches the venv path
# in the command line), so we never kill an unrelated worker or the API server.
$escaped = [regex]::Escape($BackendDir)
function Get-WorkerProcs {
    Get-CimInstance Win32_Process -Filter "Name='celery.exe' OR Name='python.exe'" |
        Where-Object { $_.CommandLine -match 'celery.*worker' -and $_.CommandLine -match $escaped }
}

Write-Host "== Backtester worker reset ==" -ForegroundColor Cyan
Write-Host "backend: $BackendDir"

# --- 1. Stop the worker (kills the running task) -------------------------------
$targets = @(Get-WorkerProcs)
if ($targets.Count -eq 0) {
    Write-Host "[1/4] No Celery worker running." -ForegroundColor Yellow
} else {
    Write-Host "[1/4] Stopping $($targets.Count) worker process(es)..."
    foreach ($p in $targets) {
        Write-Host "      PID $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800
    $left = @(Get-WorkerProcs).Count
    if ($left -gt 0) { Write-Warning "      $left worker process(es) still alive." }
    else             { Write-Host "      Worker stopped." -ForegroundColor Green }
}

# --- 2. Purge the broker -------------------------------------------------------
Write-Host "[2/4] Purging broker (queue + unacked)..."
Push-Location $BackendDir
try { & $Py $PurgePy } finally { Pop-Location }

# --- 3. Restart a fresh worker -------------------------------------------------
if ($StopOnly) {
    Write-Host "[3/4] -StopOnly set; not restarting the worker." -ForegroundColor Yellow
} else {
    Write-Host "[3/4] Starting a fresh --pool=solo worker..."
    Start-Process -FilePath $CeleryExe `
        -ArgumentList @('-A','app.celery_app.celery','worker',"--loglevel=$Loglevel",'--pool=solo') `
        -WorkingDirectory $BackendDir
    Start-Sleep -Seconds 6
    $up = @(Get-WorkerProcs).Count
    if ($up -gt 0) { Write-Host "      Worker up ($up proc)." -ForegroundColor Green }
    else           { Write-Warning "      Worker did not appear; check for startup errors." }
}

# --- 4. Verify -----------------------------------------------------------------
Write-Host "[4/4] Status:"
Push-Location $BackendDir
try { & $Py $StatusPy } finally { Pop-Location }
