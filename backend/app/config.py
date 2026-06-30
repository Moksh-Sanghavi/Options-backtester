"""Application settings, loaded from environment variables / .env."""
from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the API and Celery worker."""

    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias="REDIS_URL",
        description="Redis URL used as Celery broker and result backend.",
    )
    data_dir: Path = Field(
        default=Path(__file__).resolve().parent.parent / "data",
        validation_alias="DATA_DIR",
        description="Directory containing the .parquet datasets.",
    )
    stock_code: str = Field(default="NIFTY", validation_alias="STOCK_CODE")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    def dataset_paths(self, dataset: str) -> tuple[Path, Path]:
        """Return (options_path, spot_path) for a named dataset.

        Two layouts are supported, checked in this order:

        * **Partitioned** (multi-year): a directory ``options_<dataset>/`` of
          ``expiry=YYYY-MM-DD/data.parquet`` partitions. Preferred when present.
        * **Single file** (legacy): ``options_<dataset>.parquet``.

        Spot is always a single ``spot_<dataset>.parquet`` file.
        """
        partitioned = self.data_dir / f"options_{dataset}"
        options = partitioned if partitioned.is_dir() else self.data_dir / f"options_{dataset}.parquet"
        spot = self.data_dir / f"spot_{dataset}.parquet"
        return options, spot

    def dataset_expiries(self, dataset: str) -> list[str]:
        """List the expiry dates (YYYY-MM-DD) of a partitioned dataset, sorted.

        Reads only directory names, so it is cheap — no data is loaded. Returns
        an empty list for a non-partitioned (single-file) or missing dataset.
        """
        partitioned = self.data_dir / f"options_{dataset}"
        if not partitioned.is_dir():
            return []
        expiries = [
            child.name.split("=", 1)[1]
            for child in partitioned.glob("expiry=*")
            if child.is_dir() and "=" in child.name
        ]
        return sorted(expiries)


settings = Settings()
