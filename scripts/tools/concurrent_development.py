#!/usr/bin/env python3
"""Protocol Runner source-workspace binding CLI."""

from __future__ import annotations

import sys
from pathlib import Path

RUNNER_ROOT = Path(__file__).resolve().parents[2]
if str(RUNNER_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNNER_ROOT))

from packages.concurrent_development.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
