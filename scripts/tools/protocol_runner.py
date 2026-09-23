#!/usr/bin/env python
"""Operate the local Workstation Control Protocol Runner API."""

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


TOOL_ID = "tool.workstation_control.protocol_runner"
ENTRYPOINT = "python scripts/tools/protocol_runner.py"
DEFAULT_BASE_URL = "http://127.0.0.1:4831"
REQUEST_TIMEOUT_SECONDS = 180
COMMAND_NAMES = {
    "usage",
    "doctor",
    "list",
    "status",
    "diagnose",
    "create",
    "automation",
    "validate",
    "bind",
    "start",
    "pause",
    "resume",
    "retry-current",
    "fail",
    "close",
    "events",
    "tail",
    "show-prompt",
    "show-start",
    "show-status",
}


class ProtocolRunnerCliError(RuntimeError):
    def __init__(self, message: str, *, code: str = "protocol_runner_cli_error") -> None:
        super().__init__(message)
        self.code = code


def _usage_payload() -> dict[str, object]:
    return tool_usage_payload(
        tool_id=TOOL_ID,
        purpose="Operate and troubleshoot local Protocol Runner runs through the protocol-runner-api.",
        entrypoint=ENTRYPOINT,
        safe_first_calls=[
            {"label": "usage", "cmd": ENTRYPOINT},
            {"label": "usage-json", "cmd": f"{ENTRYPOINT} usage --format json"},
            {"label": "doctor", "cmd": f"{ENTRYPOINT} doctor --format json"},
        ],
        verbs=[
            ToolVerb("usage", "none", "Return this compact usage contract."),
            ToolVerb("doctor", "loopback read", "Check protocol-runner-api health and diagnostics."),
            ToolVerb("list", "loopback read", "List known local run instances."),
            ToolVerb("status", "loopback read", "Show concise run status, or list status when no run id is provided."),
            ToolVerb("diagnose", "loopback read", "Show detailed diagnostics for one run."),
            ToolVerb("create", "local API mutation", "Create a run from a runner-compatible work plan JSON file."),
            ToolVerb("automation", "local API mutation", "Set auto_pickup and/or auto_advance for one run."),
            ToolVerb("validate", "loopback read", "Validate a persisted run work plan through the API."),
            ToolVerb("bind", "local API mutation", "Bind a run to the configured fake or real thread/relay adapter."),
            ToolVerb("start", "prompt-send operation", "Render and send the current prompt through the configured API adapter."),
            ToolVerb("pause", "local API mutation", "Pause the run without advancing the cursor."),
            ToolVerb("resume", "prompt-send operation", "Resume by sending the current prompt again."),
            ToolVerb("retry-current", "prompt-send operation", "Retry the current step without advancing the cursor."),
            ToolVerb("fail", "local API mutation", "Mark a run failed with an operator reason."),
            ToolVerb(
                "close",
                "local API mutation",
                "Explicitly close out a paused, blocked, completed, or failed run, cleaning runner-owned relay/artifact state.",
            ),
            ToolVerb("events", "loopback read", "Read run events."),
            ToolVerb("tail", "loopback read", "Read the latest run events."),
            ToolVerb("show-prompt", "loopback read", "Print the latest or named prompt evidence file."),
            ToolVerb("show-start", "loopback read", "Print the latest or named start-report receipt."),
            ToolVerb("show-status", "loopback read", "Print the latest or named structured status-report receipt."),
        ],
        selectors=[
            ToolSelector("--base-url", False, f"Protocol Runner API base URL. Default: {DEFAULT_BASE_URL}."),
            ToolSelector("--run-instance-id", True, "Run instance id for run-specific commands."),
            ToolSelector("--work-plan", True, "Path to a runner-compatible work plan JSON file for create."),
            ToolSelector("--auto-pickup", False, "Enable structured status-report pickup for create/automation."),
            ToolSelector("--no-auto-pickup", False, "Disable structured status-report pickup for automation."),
            ToolSelector("--auto-advance", False, "Enable driver auto-advance for create/automation."),
            ToolSelector("--no-auto-advance", False, "Disable driver auto-advance for automation."),
            ToolSelector("--binding-kind", False, "Binding kind for bind: serial_desktop or parallel_only."),
            ToolSelector("--visible-thread-label", False, "Visible Codex Desktop sidebar label for serial_desktop bind."),
            ToolSelector("--reason", True, "Reason text for fail."),
            ToolSelector("--ack-source-handoff", False, "For close: repeat exact ATTEMPT_ID@COMMIT after preserving or integrating each source handoff. This never overrides live-workspace protection."),
            ToolSelector(
                "--delete-sealed-outputs",
                False,
                "For close only: also delete declared parallel sealed-output primary artifacts and empty parent folders.",
            ),
            ToolSelector("--current", False, "For show-prompt/show-start/show-status, select the latest evidence file."),
            ToolSelector("--file-name", False, "For show-prompt/show-start/show-status, read a specific evidence file name."),
            ToolSelector("--limit", False, "Event limit for events/tail."),
        ],
        output_formats=["text", "json"],
        side_effects={
            "writes_repo": False,
            "writes_paths": [],
            "modifies_remote": "fake mode: none; real mode: bind can create a runner-owned Discord channel, start/resume/retry can prompt Codex Desktop through protocol-runner-api, and close can clean up the runner-owned Discord binding/channel",
            "network_access": "loopback_http_to_protocol_runner_api",
            "danger_level": "medium",
            "supports_dry_run": False,
            "preview_or_plan_verbs": [],
            "safety": "Only start, resume, and retry-current can send prompts. close is explicit cleanup and deletes runner-instance procedural artifacts while preserving contract work outputs unless --delete-sealed-outputs is explicitly supplied for declared parallel sealed-output primary artifacts.",
        },
        examples=[
            {"label": "Usage JSON", "cmd": f"{ENTRYPOINT} usage --format json"},
            {"label": "Doctor", "cmd": f"{ENTRYPOINT} doctor --format json"},
            {"label": "Create", "cmd": f"{ENTRYPOINT} create --work-plan <work_plan.json> --run-instance-id <run_id>"},
            {"label": "Enable pickup", "cmd": f"{ENTRYPOINT} automation --run-instance-id <run_id> --auto-pickup"},
            {
                "label": "Bind serial Desktop",
                "cmd": f"{ENTRYPOINT} bind --run-instance-id <run_id> --binding-kind serial_desktop --visible-thread-label <label>",
            },
            {"label": "Bind pure parallel", "cmd": f"{ENTRYPOINT} bind --run-instance-id <run_id> --binding-kind parallel_only"},
            {"label": "Start", "cmd": f"{ENTRYPOINT} start --run-instance-id <run_id>"},
            {"label": "Diagnose", "cmd": f"{ENTRYPOINT} diagnose --run-instance-id <run_id>"},
            {
                "label": "Full closeout after promotion",
                "cmd": f"{ENTRYPOINT} close --run-instance-id <run_id> --delete-sealed-outputs",
            },
        ],
        docs=[
            "README.md",
            "docs/architecture.md",
            "contracts/protocol-runner.openapi.yaml",
        ],
        errors=[
            {"code": "api_unavailable", "meaning": "protocol-runner-api is not reachable at --base-url."},
            {"code": "api_rejected", "meaning": "protocol-runner-api rejected the requested operation."},
            {"code": "missing_evidence", "meaning": "No matching prompt/start/status evidence file exists yet."},
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


def _normalize_global_flag_order(argv: list[str]) -> list[str]:
    command_index = next((index for index, token in enumerate(argv) if token in COMMAND_NAMES), None)
    if command_index is None or command_index == 0:
        return list(argv)

    command = argv[command_index]
    prefix = argv[:command_index]
    suffix = argv[command_index + 1 :]
    moved: list[str] = []
    retained: list[str] = []
    value_options = {"--base-url", "--format"}
    flag_options = {"--json"}
    index = 0
    while index < len(prefix):
        token = prefix[index]
        if token in flag_options:
            moved.append(token)
        elif token in value_options and index + 1 < len(prefix):
            moved.extend([token, prefix[index + 1]])
            index += 1
        elif any(token.startswith(f"{option}=") for option in value_options):
            moved.append(token)
        else:
            retained.append(token)
        index += 1
    return [*retained, command, *moved, *suffix]


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--base-url",
        default=os.environ.get("PROTOCOL_RUNNER_API_URL", DEFAULT_BASE_URL),
        help=f"Protocol Runner API base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Output format.")
    parser.add_argument("--json", action="store_true", help="Alias for --format json.")


def add_run_id_arg(parser: argparse.ArgumentParser, *, required: bool = True) -> None:
    parser.add_argument("--run-instance-id", required=required, help="Protocol Runner run instance id.")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    usage = subparsers.add_parser("usage", help="Return the compact tool usage contract.")
    usage.add_argument("--format", choices=("text", "json"), default="text", help="Output format.")
    usage.add_argument("--json", action="store_true", help="Alias for --format json.")

    doctor = subparsers.add_parser("doctor", help="Check API health and diagnostics.")
    add_common_args(doctor)

    list_runs = subparsers.add_parser("list", help="List known runs.")
    add_common_args(list_runs)

    create = subparsers.add_parser("create", help="Create a run from a work plan JSON file.")
    add_common_args(create)
    create.add_argument("--work-plan", required=True, help="Path to work plan JSON.")
    add_run_id_arg(create, required=False)
    create.add_argument("--auto-pickup", action="store_true", help="Create the run with auto_pickup=true.")
    create.add_argument("--auto-advance", action="store_true", help="Create the run with auto_advance=true.")

    automation = subparsers.add_parser("automation", help="Set run automation flags.")
    add_common_args(automation)
    add_run_id_arg(automation)
    automation.add_argument("--auto-pickup", action="store_true", help="Set auto_pickup=true.")
    automation.add_argument("--no-auto-pickup", action="store_true", help="Set auto_pickup=false.")
    automation.add_argument("--auto-advance", action="store_true", help="Set auto_advance=true.")
    automation.add_argument("--no-auto-advance", action="store_true", help="Set auto_advance=false.")

    status = subparsers.add_parser("status", help="Show concise run status.")
    add_common_args(status)
    add_run_id_arg(status, required=False)

    diagnose = subparsers.add_parser("diagnose", help="Show detailed run diagnostics.")
    add_common_args(diagnose)
    add_run_id_arg(diagnose)

    validate = subparsers.add_parser("validate", help="Validate a persisted run work plan.")
    add_common_args(validate)
    add_run_id_arg(validate)

    bind = subparsers.add_parser("bind", help="Bind a run to the configured fake or real runner adapter.")
    add_common_args(bind)
    add_run_id_arg(bind)
    bind.add_argument("--binding-kind", choices=["serial_desktop", "parallel_only"], help="Binding kind.")
    bind.add_argument("--visible-thread-label", help="Visible Codex Desktop sidebar label for serial_desktop binding.")
    bind.add_argument("--relay-channel-id", help="Optional fake relay channel id override.")
    bind.add_argument("--relay-channel-name", help="Optional fake relay channel name override.")
    bind.add_argument("--binding-id", help="Optional fake binding id override.")

    for verb in ("start", "pause", "resume", "retry-current"):
        subparser = subparsers.add_parser(verb, help=f"{verb} a run.")
        add_common_args(subparser)
        add_run_id_arg(subparser)

    close = subparsers.add_parser("close", help="Close out a run and clean runner-owned state.")
    add_common_args(close)
    add_run_id_arg(close)
    close.add_argument(
        "--delete-sealed-outputs",
        action="store_true",
        help="Also delete declared parallel sealed-output primary artifacts and empty parent folders.",
    )
    close.add_argument(
        "--ack-source-handoff", action="append", default=[], metavar="ATTEMPT_ID@COMMIT",
        help="Acknowledge an exact source contribution after the coordinator integrated or preserved it; repeat for each handoff.",
    )

    fail = subparsers.add_parser("fail", help="Mark a run failed.")
    add_common_args(fail)
    add_run_id_arg(fail)
    fail.add_argument("--reason", required=True, help="Reason for failing the run.")

    events = subparsers.add_parser("events", help="Read run events.")
    add_common_args(events)
    add_run_id_arg(events)
    events.add_argument("--limit", type=int, help="Optional event limit.")

    tail = subparsers.add_parser("tail", help="Read the latest run events.")
    add_common_args(tail)
    add_run_id_arg(tail)
    tail.add_argument("--limit", type=int, default=20, help="Latest event count. Default: 20.")

    for verb in ("show-prompt", "show-start", "show-status"):
        subparser = subparsers.add_parser(verb, help=f"Read {verb.removeprefix('show-')} evidence.")
        add_common_args(subparser)
        add_run_id_arg(subparser)
        subparser.add_argument("--current", action="store_true", help="Show latest evidence file. Default when --file-name is omitted.")
        subparser.add_argument("--file-name", help="Specific evidence file name.")

    return parser


def request_json(base_url: str, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        headers = control_headers(base_url)
    except ValueError as error:
        raise ProtocolRunnerCliError(str(error), code="local_config_error") from error
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        method=method,
        headers={**headers, "Content-Type": "application/json"},
    )
    try:
        with LOCAL_OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_text = error.read().decode("utf-8", errors="replace")
        raise ProtocolRunnerCliError(
            f"protocol-runner-api rejected request: HTTP {error.code} {response_text}",
            code="api_rejected",
        ) from error
    except urllib.error.URLError as error:
        raise ProtocolRunnerCliError(f"protocol-runner-api unavailable: {error}", code="api_unavailable") from error


def request_text(base_url: str, path: str) -> str:
    try:
        headers = control_headers(base_url)
    except ValueError as error:
        raise ProtocolRunnerCliError(str(error), code="local_config_error") from error
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", method="GET", headers=headers)
    try:
        with LOCAL_OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        response_text = error.read().decode("utf-8", errors="replace")
        raise ProtocolRunnerCliError(
            f"protocol-runner-api rejected request: HTTP {error.code} {response_text}",
            code="api_rejected",
        ) from error
    except urllib.error.URLError as error:
        raise ProtocolRunnerCliError(f"protocol-runner-api unavailable: {error}", code="api_unavailable") from error


def api_path(*segments: str, query: dict[str, str | int] | None = None) -> str:
    encoded = "/".join(urllib.parse.quote(segment, safe="") for segment in segments)
    if query:
        return f"/{encoded}?{urllib.parse.urlencode(query)}"
    return f"/{encoded}"


def load_work_plan(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as error:
        raise ProtocolRunnerCliError(f"Failed to read work plan {path}: {error}", code="work_plan_read_failed") from error
    except json.JSONDecodeError as error:
        raise ProtocolRunnerCliError(f"Work plan is not valid JSON: {error}", code="work_plan_json_invalid") from error
    if not isinstance(value, dict):
        raise ProtocolRunnerCliError("Work plan JSON root must be an object.", code="work_plan_invalid")
    return value


def run_from_response(response: dict[str, Any]) -> dict[str, Any] | None:
    run = response.get("run")
    return run if isinstance(run, dict) else None


def state_from_response(response: dict[str, Any]) -> dict[str, Any] | None:
    run = run_from_response(response)
    state = run.get("state") if run else None
    return state if isinstance(state, dict) else None


def summarize_run(run: dict[str, Any]) -> str:
    state = run.get("state") if isinstance(run.get("state"), dict) else {}
    automation = state.get("automation") if isinstance(state.get("automation"), dict) else {}
    return " ".join(
        [
            f"run_instance_id={run.get('run_instance_id')}",
            f"status={state.get('status')}",
            f"current_step={state.get('current_step_id')}",
            f"ordinal={state.get('current_step_ordinal')}",
            f"auto_pickup={automation.get('auto_pickup')}",
            f"auto_advance={automation.get('auto_advance')}",
            f"updated_at={(state.get('timestamps') or {}).get('updated_at') if isinstance(state.get('timestamps'), dict) else None}",
        ]
    )


def summarize_runs(runs: list[dict[str, Any]]) -> str:
    if not runs:
        return "No protocol runner runs found.\n"
    return "\n".join(
        " ".join(
            [
                f"run_instance_id={run.get('run_instance_id')}",
                f"status={run.get('status')}",
                f"current_step={run.get('current_step_id')}",
                f"ordinal={run.get('current_step_ordinal')}",
                f"auto_pickup={(run.get('automation') or {}).get('auto_pickup') if isinstance(run.get('automation'), dict) else None}",
                f"auto_advance={(run.get('automation') or {}).get('auto_advance') if isinstance(run.get('automation'), dict) else None}",
                f"updated_at={run.get('updated_at')}",
            ]
        )
        for run in runs
    ) + "\n"


def summarize_diagnostics(diagnostics: dict[str, Any]) -> str:
    lines = [
        f"run_instance_id={diagnostics.get('run_instance_id')}",
        f"status={diagnostics.get('status')}",
        f"current_step={diagnostics.get('current_step_id')}",
        f"ordinal={diagnostics.get('current_step_ordinal')}",
    ]
    automation = diagnostics.get("automation") if isinstance(diagnostics.get("automation"), dict) else {}
    lines.append(f"auto_pickup={automation.get('auto_pickup')}")
    lines.append(f"auto_advance={automation.get('auto_advance')}")
    if diagnostics.get("blocked_reason"):
        lines.append(f"blocked_reason={diagnostics.get('blocked_reason')}")
    lines.append("next_allowed_actions:")
    for action in diagnostics.get("next_allowed_actions") or []:
        if isinstance(action, dict):
            lines.append(f"- {action.get('action')}: enabled={action.get('enabled')} reason={action.get('reason')}")
    lines.append("latest_files:")
    for key, value in (diagnostics.get("latest_files") or {}).items():
        lines.append(f"- {key}: {value}")
    evidence = diagnostics.get("evidence_paths") if isinstance(diagnostics.get("evidence_paths"), dict) else {}
    if evidence:
        lines.append("evidence_paths:")
        for key in ("run_dir", "work_plan_path", "state_path", "events_path"):
            lines.append(f"- {key}: {evidence.get(key)}")
    return "\n".join(lines) + "\n"


def summarize_closeout(closeout: dict[str, Any]) -> str:
    relay = closeout.get("relay_cleanup") if isinstance(closeout.get("relay_cleanup"), dict) else {}
    artifacts = closeout.get("artifact_cleanup") if isinstance(closeout.get("artifact_cleanup"), dict) else {}
    sealed_outputs = closeout.get("sealed_output_cleanup") if isinstance(closeout.get("sealed_output_cleanup"), dict) else {}
    return "\n".join(
        [
            f"run_instance_id={closeout.get('run_instance_id')}",
            f"relay_cleanup={relay.get('cleanup_state')}",
            f"relay_channel_id={relay.get('channel_id')}",
            f"sealed_outputs_requested={sealed_outputs.get('requested')}",
            f"sealed_output_targets={sealed_outputs.get('target_count')}",
            f"sealed_output_files_deleted={sealed_outputs.get('deleted_files')}",
            f"sealed_output_files_missing={sealed_outputs.get('missing_files')}",
            f"sealed_output_empty_dirs_deleted={sealed_outputs.get('deleted_empty_dirs')}",
            f"artifacts_deleted={artifacts.get('deleted')}",
            f"run_dir={artifacts.get('run_dir')}",
        ]
    ) + "\n"


def summarize_events(events: list[dict[str, Any]]) -> str:
    if not events:
        return "No events.\n"
    lines = []
    for event in events:
        lines.append(
            " ".join(
                [
                    str(event.get("timestamp")),
                    str(event.get("event_type")),
                    f"step={event.get('step_id')}",
                    f"event_id={event.get('event_id')}",
                ]
            )
        )
    return "\n".join(lines) + "\n"


def result(command: str, response: dict[str, Any], summary: str) -> dict[str, Any]:
    return tool_result_payload(tool_id=TOOL_ID, verb=command, summary=summary, data={"response": response})


def emit_result(args: argparse.Namespace, payload: dict[str, Any], text: str | None = None) -> None:
    output_format = normalize_format(args.format, json_alias=args.json)
    if output_format == "json":
        emit_payload(payload, output_format="json", stream=sys.stdout)
        return
    if text is not None:
        sys.stdout.write(text)
        return
    emit_payload(payload, output_format="text", stream=sys.stdout)


def latest_file_name(base_url: str, run_instance_id: str, kind: str) -> str:
    response = request_json(base_url, "GET", api_path("api", "runs", run_instance_id, "diagnostics"))
    diagnostics = response.get("diagnostics") if isinstance(response.get("diagnostics"), dict) else {}
    latest_files = diagnostics.get("latest_files") if isinstance(diagnostics, dict) else {}
    relative = latest_files.get(kind) if isinstance(latest_files, dict) else None
    if not isinstance(relative, str) or not relative:
        raise ProtocolRunnerCliError(f"No {kind} evidence file exists for run {run_instance_id}.", code="missing_evidence")
    return Path(relative).name


def command_body(args: argparse.Namespace) -> tuple[dict[str, Any], str | None]:
    command = args.command
    base_url = args.base_url

    if command == "doctor":
        health = request_json(base_url, "GET", "/health")
        diagnostics = request_json(base_url, "GET", "/api/diagnostics")
        response = {"health": health, "diagnostics": diagnostics}
        return result(command, response, "protocol-runner-api is reachable."), None

    if command == "list":
        response = request_json(base_url, "GET", "/api/runs")
        runs = response.get("runs") if isinstance(response.get("runs"), list) else []
        return result(command, response, f"Found {len(runs)} run(s)."), summarize_runs([run for run in runs if isinstance(run, dict)])

    if command == "create":
        payload: dict[str, Any] = {"work_plan": load_work_plan(args.work_plan)}
        if args.run_instance_id:
            payload["run_instance_id"] = args.run_instance_id
        payload["automation"] = {"auto_pickup": bool(args.auto_pickup), "auto_advance": bool(args.auto_advance)}
        response = request_json(base_url, "POST", "/api/runs", payload)
        run = run_from_response(response)
        return result(command, response, "Run created."), summarize_run(run) + "\n" if run else None

    if command == "automation":
        if args.auto_pickup and args.no_auto_pickup:
            raise ProtocolRunnerCliError("--auto-pickup and --no-auto-pickup cannot both be set.", code="invalid_flags")
        if args.auto_advance and args.no_auto_advance:
            raise ProtocolRunnerCliError("--auto-advance and --no-auto-advance cannot both be set.", code="invalid_flags")
        payload = {}
        if args.auto_pickup or args.no_auto_pickup:
            payload["auto_pickup"] = bool(args.auto_pickup)
        if args.auto_advance or args.no_auto_advance:
            payload["auto_advance"] = bool(args.auto_advance)
        if not payload:
            raise ProtocolRunnerCliError("Specify at least one automation flag.", code="invalid_flags")
        response = request_json(base_url, "POST", api_path("api", "runs", args.run_instance_id, "automation"), payload)
        run = run_from_response(response)
        return result(command, response, "Run automation updated."), summarize_run(run) + "\n" if run else None

    if command == "status":
        if not args.run_instance_id:
            response = request_json(base_url, "GET", "/api/runs")
            runs = response.get("runs") if isinstance(response.get("runs"), list) else []
            return result(command, response, f"Found {len(runs)} run(s)."), summarize_runs(
                [run for run in runs if isinstance(run, dict)]
            )
        response = request_json(base_url, "GET", api_path("api", "runs", args.run_instance_id))
        run = run_from_response(response)
        return result(command, response, "Run status loaded."), summarize_run(run) + "\n" if run else None

    if command == "diagnose":
        response = request_json(base_url, "GET", api_path("api", "runs", args.run_instance_id, "diagnostics"))
        diagnostics = response.get("diagnostics") if isinstance(response.get("diagnostics"), dict) else {}
        return result(command, response, "Run diagnostics loaded."), summarize_diagnostics(diagnostics)

    if command == "validate":
        response = request_json(base_url, "POST", api_path("api", "runs", args.run_instance_id, "validate"))
        ok = ((response.get("validation") or {}) if isinstance(response.get("validation"), dict) else {}).get("ok")
        return result(command, response, f"Run validation ok={ok}."), None

    if command == "bind":
        payload = {
            "binding_kind": args.binding_kind,
            "visible_thread_label": args.visible_thread_label,
            "relay_channel_id": args.relay_channel_id,
            "relay_channel_name": args.relay_channel_name,
            "binding_id": args.binding_id,
        }
        response = request_json(
            base_url,
            "POST",
            api_path("api", "runs", args.run_instance_id, "bind"),
            {key: value for key, value in payload.items() if value is not None},
        )
        run = run_from_response(response)
        return result(command, response, "Run bound."), summarize_run(run) + "\n" if run else None

    if command in {"start", "pause", "resume", "retry-current"}:
        response = request_json(base_url, "POST", api_path("api", "runs", args.run_instance_id, command))
        run = run_from_response(response)
        return result(command, response, f"{command} completed."), summarize_run(run) + "\n" if run else None

    if command == "close":
        payload = {"delete_sealed_outputs": True} if args.delete_sealed_outputs else {}
        if args.ack_source_handoff:
            payload["source_handoff_acknowledgements"] = args.ack_source_handoff
        payload = payload or None
        response = request_json(base_url, "POST", api_path("api", "runs", args.run_instance_id, command), payload)
        closeout = response.get("closeout") if isinstance(response.get("closeout"), dict) else {}
        return result(command, response, "Run closeout completed."), summarize_closeout(closeout)

    if command == "fail":
        response = request_json(
            base_url,
            "POST",
            api_path("api", "runs", args.run_instance_id, "fail"),
            {"reason": args.reason},
        )
        run = run_from_response(response)
        return result(command, response, "Run marked failed."), summarize_run(run) + "\n" if run else None

    if command in {"events", "tail"}:
        query = {"limit": args.limit} if args.limit else None
        response = request_json(base_url, "GET", api_path("api", "runs", args.run_instance_id, "events", query=query))
        events = response.get("events") if isinstance(response.get("events"), list) else []
        return result(command, response, f"Loaded {len(events)} event(s)."), summarize_events(
            [event for event in events if isinstance(event, dict)]
        )

    if command in {"show-prompt", "show-start", "show-status"}:
        kind = {
            "show-prompt": "prompt",
            "show-start": "start",
            "show-status": "status",
        }[command]
        file_name = args.file_name or latest_file_name(base_url, args.run_instance_id, kind)
        file_kind = "prompts" if kind == "prompt" else "starts" if kind == "start" else "status"
        text = request_text(base_url, api_path("api", "runs", args.run_instance_id, "files", file_kind, file_name))
        payload = tool_result_payload(
            tool_id=TOOL_ID,
            verb=command,
            summary=f"Loaded {kind} evidence file {file_name}.",
            data={"run_instance_id": args.run_instance_id, "file_name": file_name, "text": text},
        )
        return payload, text

    raise ProtocolRunnerCliError(f"Unsupported command: {command}", code="unsupported_command")


def main(argv: list[str]) -> int:
    if _is_usage_request(argv):
        emit_payload(_usage_payload(), output_format=_usage_format(argv), stream=sys.stdout)
        return 0

    args = _build_parser().parse_args(_normalize_global_flag_order(argv))
    if args.command == "usage":
        emit_payload(_usage_payload(), output_format=normalize_format(args.format, json_alias=args.json), stream=sys.stdout)
        return 0

    try:
        payload, text = command_body(args)
    except ProtocolRunnerCliError as error:
        error_payload = tool_result_payload(
            tool_id=TOOL_ID,
            verb=getattr(args, "command", "unknown"),
            status="error",
            summary=str(error),
            errors=[{"code": error.code, "message": str(error)}],
        )
        output_format = normalize_format(args.format, json_alias=args.json) if hasattr(args, "format") else "text"
        emit_payload(error_payload, output_format=output_format, stream=sys.stderr)
        return 1

    emit_result(args, payload, text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
