"""Delete the Celery broker's queue + reserved-task records from Redis.

Drops the 'celery' queue list and the 'unacked'/'unacked_index' structures so a
killed in-flight task is not redelivered to a freshly started worker. Stored
results (celery-task-meta-*) are left alone -- they expire on their own and the
run history is also persisted to the app DB.

Stop the worker BEFORE running this; purging alone does not cancel a task that a
worker is already executing. Used by scripts\reset_worker.ps1, but safe to run
standalone from the backend/ dir::

    .venv\\Scripts\\python.exe scripts\\purge_broker.py
"""
from __future__ import annotations

import os
import sys

import redis

try:
    from app.config import settings
except ModuleNotFoundError:  # pragma: no cover - path bootstrap
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from app.config import settings


def main() -> int:
    r = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=3)
    before = {"waiting": r.llen("celery"), "in_flight": r.hlen("unacked")}
    deleted = r.delete("celery", "unacked", "unacked_index")
    after = {"waiting": r.llen("celery"), "in_flight": r.hlen("unacked")}
    print(f"      before: {before}")
    print(f"      keys deleted: {deleted}")
    print(f"      after : {after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
