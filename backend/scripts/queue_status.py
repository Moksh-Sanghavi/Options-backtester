"""One-shot Celery/Redis queue health check for the backtester.

Answers, in a single command, the three things you'd otherwise check by hand:

  1. Are the broker (Redis) and the Celery worker running?
  2. Is the queue empty?  -> ``waiting`` count (tasks queued, not yet started)
  3. Is the worker idle or grinding on a task?  -> control ping + process check

Run it from the ``backend/`` directory (virtualenv active)::

    python -m scripts.queue_status
    # or, without activating the venv:
    .venv\\Scripts\\python.exe scripts\\queue_status.py

Exit code is 0 when the queue is empty (waiting == 0 and in-flight == 0),
1 when the broker is down, 2 when work is still queued/running -- handy for
scripting ("only start a fresh run if this returns 0").
"""
from __future__ import annotations

import os
import subprocess
import sys

import redis

# Make the script runnable both as ``python -m scripts.queue_status`` and as a
# bare ``python scripts\queue_status.py`` (the latter needs backend/ on sys.path).
try:
    from app.celery_app import celery
    from app.config import settings
except ModuleNotFoundError:  # pragma: no cover - path bootstrap
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from app.celery_app import celery
    from app.config import settings


def _connect_broker():
    """Return (redis_client, None) if reachable, else (None, error)."""
    r = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=3)
    try:
        r.ping()
    except Exception as exc:  # noqa: BLE001 - report any connection failure
        return None, exc
    return r, None


def _count_worker_processes() -> int | None:
    """Number of running Celery worker processes, via Windows ``tasklist``.

    Returns None on non-Windows hosts or if ``tasklist`` is unavailable, so the
    caller can fall back to the control-ping result alone.
    """
    if os.name != "nt":
        return None
    try:
        out = subprocess.run(
            ["tasklist", "/v", "/fo", "csv"],
            capture_output=True,
            text=True,
            timeout=8,
        ).stdout.lower()
    except Exception:  # noqa: BLE001
        return None
    # The solo worker appears as celery.exe (master) plus python children whose
    # command line runs "celery ... worker"; counting celery.exe is the cleanest
    # signal of a live worker tree.
    return out.count("celery.exe")


def _ping_workers() -> list[str]:
    """Names of worker nodes that answer a short control ping.

    A busy ``--pool=solo`` worker cannot reply mid-task, so an empty list does
    NOT prove the worker is down -- cross-check with the process count.
    """
    try:
        replies = celery.control.ping(timeout=2.0)
    except Exception:  # noqa: BLE001
        return []
    return [name for reply in (replies or []) for name in reply]


def main() -> int:
    print("Backtester queue status")
    print("=" * 42)
    print(f"broker url : {settings.redis_url}")

    r, err = _connect_broker()
    if r is None:
        print(f"redis      : DOWN ({err})")
        print("\n=> Broker not running. Start Redis, then the Celery worker.")
        return 1
    print("redis      : UP")

    # Default queue is a Redis LIST named 'celery'; reserved tasks move to the
    # 'unacked' hash while a worker holds them.
    waiting = r.llen("celery")
    in_flight = r.hlen("unacked")
    results = len(r.keys("celery-task-meta-*"))

    print(f"\nwaiting (queued, not started) : {waiting}")
    print(f"in-flight (reserved/running)  : {in_flight}")
    print(f"stored results (~last hour)   : {results}")

    procs = _count_worker_processes()
    responders = _ping_workers()
    if responders:
        print(f"\nworker     : UP, idle (responded) -> {', '.join(responders)}")
    elif procs:
        print(f"\nworker     : UP, busy mid-task (no ping reply; {procs} celery proc)")
    elif procs == 0:
        print("\nworker     : DOWN (no celery process found)")
    else:
        print("\nworker     : unknown (no ping reply; process check unavailable)")

    empty = waiting == 0 and in_flight == 0
    print(f"\nverdict    : {'EMPTY - safe to start a fresh run' if empty else 'NOT empty'}")
    return 0 if empty else 2


if __name__ == "__main__":
    raise SystemExit(main())
