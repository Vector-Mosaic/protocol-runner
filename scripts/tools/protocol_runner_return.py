#!/usr/bin/env python
"""Submit a structured status report to the local Protocol Runner API."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from repo_platform.tooling.tool_handshake import (
    ToolSelector,
    ToolVerb,
    emit_payload,
    normalize_format,
    tool_result_payload,
    tool_usage_payload,
)
from scripts.tools.protocol_runner_auth import LOCAL_OPENER, control_headers


TOOL_ID = "tool.workstation_control.protocol_runner_return"
ENTRYPOINT = "python scripts/tools/protocol_runner_return.py"
DEFAULT_BASE_URL = "http://127.0.0.1:4831"


class ProtocolRunnerReturnError(RuntimeError):
    def __init__(self, message: str, *, code: str = "protocol_runner_return_error") -> None:
        super().__init__(message)
        self.code = code


def _usage_payload() -> dict[str, object]:
    return tool_usage_payload(
        tool_id=TOOL_ID,
        purpose="Submit a structured Protocol Runner status report for the current run step.",
        entrypoint=ENTRYPOINT,
        safe_first_calls=[
            {"label": "usage", "cmd": ENTRYPOINT},
            {"label": "usage-json", "cmd": f"{ENTRYPOINT} usage --format json"},
        ],
        verbs=[
            ToolVerb("usage", "none", "Return this compact usage contract."),
            ToolVerb("submit", "local API mutation", "Submit completed or blocked status for one waiting run step."),
        ],
        selectors=[
            ToolSelector("--base-url", False, f"Protocol Runner API base URL. Default: {DEFAULT_BASE_URL}."),
            ToolSelector("--run-instance-id", True, "Run instance id that is waiting for a structured completion status report."),
            ToolSelector("--step-id", True, "Expected current step id. The API validates it against the active cursor."),
            ToolSelector("--status", True, "Structured status report value: completed or blocked."),
            ToolSelector("--summary", False, "Short procedural summary for the status receipt."),
        ],
        output_formats=["text", "json"],
        side_effects={
            "writes_repo": False,
            "writes_paths": [],
            "modifies_remote": "none",
            "network_access": "loopback_http_to_protocol_runner_api",
            "danger_level": "medium",
            "supports_dry_run": False,
            "preview_or_plan_verbs": [],
            "safety": "This helper does not read Codex's visible response, parse completion blocks, or apply transitions; protocol-runner-api validates the structured status report and owns transitions.",
        },
        examples=[
            {
                "label": "Submit completed status",
                "cmd": f"{ENTRYPOINT} --run-instance-id <run_id> --step-id <step_id> --status completed --summary \"step complete\"",
            },
            {
                "label": "Submit blocked status",
                "cmd": f"{ENTRYPOINT} --run-instance-id <run_id> --step-id <step_id> --status blocked --summary \"blocked reason\" --format json",
            },
        ],
        docs=[
            "README.md",
            "docs/architecture.md",
            "contracts/protocol-runner.openapi.yaml",
        ],
        errors=[
            {"code": "api_unavailable", "meaning": "protocol-runner-api is not reachable at --base-url."},
            {"code": "api_rejected", "meaning": "protocol-runner-api rejected or blocked the submitted status report."},
        ],
    )


def _usage_format(argv: list[str]) -> str:
    raw_format: str | None = None
    json_alias = False
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--json":
            json_alias = True
        elif token == "--format" and index + 1 < len(argv):
            raw_format = argv[index + 1]
            index += 1
        elif token.startswith("--format="):
            raw_format = token.split("=", 1)[1]
        index += 1
    return normalize_format(raw_format or "text", json_alias=json_alias)


def _is_usage_request(argv: list[str]) -> bool:
    if not argv:
        return True
    allowed = {"usage", "--json", "--format", "json", "text"}
    return "usage" in argv and all(token in allowed or token.startswith("--format=") for token in argv)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-instance-id", required=True, help="Protocol Runner run instance id.")
    parser.add_argument("--step-id", required=True, help="Expected current step id.")
    parser.add_argument("--status", choices=("completed", "blocked"), required=True, help="Structured status report value.")
    parser.add_argument("--summary", help="Short procedural summary for the status receipt.")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("PROTOCOL_RUNNER_API_URL", DEFAULT_BASE_URL),
        help=f"Protocol Runner API base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Output format.")
    parser.add_argument("--json", action="store_true", help="Alias for --format json.")
    return parser


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "run_instance_id": args.run_instance_id,
        "step_id": args.step_id,
        "status": args.status,
    }
    if args.summary is not None:
        payload["summary"] = args.summary
    return payload


def api_path(*segments: str) -> str:
    return "/" + "/".join(urllib.parse.quote(segment, safe="") for segment in segments)


def request_json(base_url: str, method: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        headers = control_headers(base_url)
    except ValueError as error:
        raise ProtocolRunnerReturnError(str(error), code="local_config_error") from error
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=json.dumps(payload).encode("utf-8"),
        method=method,
        headers={**headers, "Content-Type": "application/json"},
    )
    try:
        with LOCAL_OPENER.open(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_text = error.read().decode("utf-8", errors="replace")
        raise ProtocolRunnerReturnError(
            f"protocol-runner-api rejected status report: HTTP {error.code} {response_text}",
            code="api_rejected",
        ) from error
    except urllib.error.URLError as error:
        raise ProtocolRunnerReturnError(f"protocol-runner-api unavailable: {error}", code="api_unavailable") from error


def summarize_response(response: dict[str, Any]) -> str:
    run = response.get("run") if isinstance(response.get("run"), dict) else {}
    state = run.get("state") if isinstance(run.get("state"), dict) else {}
    transition = response.get("transition") if isinstance(response.get("transition"), dict) else {}
    parts = [
        f"run_instance_id={run.get('run_instance_id')}",
        f"status={state.get('status')}",
        f"current_step={state.get('current_step_id')}",
        f"transition={transition.get('action')}",
    ]
    if state.get("blocked_reason"):
        parts.append(f"blocked_reason={state.get('blocked_reason')}")
    status_file = response.get("status_file")
    if isinstance(status_file, dict):
        parts.append(f"status_file={status_file.get('relative_path')}")
    return " ".join(parts) + "\n"


def main(argv: list[str]) -> int:
    if _is_usage_request(argv):
        emit_payload(_usage_payload(), output_format=_usage_format(argv), stream=sys.stdout)
        return 0

    args = _build_parser().parse_args(argv)
    try:
        payload = build_payload(args)
        response = request_json(
            args.base_url,
            "POST",
            api_path("api", "runs", args.run_instance_id, "return"),
            payload,
        )
    except ProtocolRunnerReturnError as error:
        payload = tool_result_payload(
            tool_id=TOOL_ID,
            verb="submit",
            status="error",
            summary=str(error),
            errors=[{"code": error.code, "message": str(error)}],
        )
        emit_payload(payload, output_format=normalize_format(args.format, json_alias=args.json), stream=sys.stderr)
        return 1

    payload = tool_result_payload(
        tool_id=TOOL_ID,
        verb="submit",
        summary="Status report submitted to protocol-runner-api.",
        data={"response": response},
    )
    output_format = normalize_format(args.format, json_alias=args.json)
    if output_format == "json":
        emit_payload(payload, output_format="json", stream=sys.stdout)
    else:
        sys.stdout.write(summarize_response(response))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
