"""Local Protocol Runner authentication shared by the command-line clients."""

from __future__ import annotations

import os
from pathlib import Path
import re
import urllib.parse
import urllib.request


REPO_ROOT = Path(__file__).resolve().parents[2]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Do not send local control credentials through an environment-configured proxy
# or carry them to a redirect destination.
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def control_headers(base_url: str) -> dict[str, str]:
    url = urllib.parse.urlsplit(base_url)
    if (
        url.scheme != "http"
        or url.hostname not in {"127.0.0.1", "localhost", "::1"}
        or url.username is not None
        or url.password is not None
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
    ):
        raise ValueError("Protocol Runner API URL must be one loopback HTTP origin.")
    # Accessing .port also validates malformed/out-of-range ports before I/O.
    _ = url.port
    token = os.environ.get("PROTOCOL_RUNNER_CONTROL_TOKEN", "").strip()
    if not token:
        try:
            token = (REPO_ROOT / ".protocol-runner" / "control-token").read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ValueError("Local control token is unavailable. Start the runner through scripts/run.mjs or set PROTOCOL_RUNNER_CONTROL_TOKEN.") from error
    if not re.fullmatch(r"[\x21-\x7e]{32,1024}", token):
        raise ValueError("Local control token must contain 32 to 1024 printable non-space ASCII characters.")
    return {"Authorization": f"Bearer {token}"}
