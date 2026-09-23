"""Bind and release exact Runner-owned Git workspaces."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence, TextIO

from repo_platform.tooling.tool_handshake import (
    ToolSelector,
    ToolVerb,
    argparse_command_details,
    emit_payload,
    tool_result_payload,
    tool_usage_payload,
)

TOOL_ID = "protocol_runner.cli.source_workspace"
ENTRYPOINT = "python scripts/tools/concurrent_development.py"
GLOBAL_OPTIONS = {"--root", "--state-root", "--format"}


class _UsageError(ValueError):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise _UsageError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog=ENTRYPOINT, description=__doc__, allow_abbrev=False)
    parser.add_argument("--root", default=".", help="Exact target Git workspace; independent of where Runner is installed.")
    parser.add_argument("--state-root", help="Local binding-state directory; defaults to ProtocolRunner/source-workspaces in the user state directory.")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Output format; works before or after the verb.")
    verbs = parser.add_subparsers(dest="verb")
    verbs.add_parser("usage", help="Describe commands without inspecting Git or writing state.", allow_abbrev=False)
    bind = verbs.add_parser("bind", help="Register an exact Runner workspace owner and incorporated base.", allow_abbrev=False)
    bind.add_argument("--binding-id", required=True, help="Stable identity for this exact workspace binding.")
    bind.add_argument("--owner-id", required=True, help="Exact Runner run/group/item/attempt owner identity.")
    bind.add_argument("--base", required=True, help="Exact commit incorporated in this workspace's Git history.")
    bind.add_argument("--lifecycle-owner", choices=("runner",), default="runner", help="Runner owns workspace creation, handoff and removal.")
    bind.add_argument("--owned-path", action="append", default=[], help="Exact repository-relative owned file; repeat for multiple files.")
    release = verbs.add_parser("release-binding", help="Release the exact owner's empty binding; preserve the workspace and Git history.", allow_abbrev=False)
    release.add_argument("--binding-id", required=True, help="Exact locally registered binding identity.")
    release.add_argument("--owner-id", required=True, help="Exact Runner owner identity originally supplied to bind.")
    return parser


def usage_payload() -> dict[str, Any]:
    return tool_usage_payload(
        tool_id=TOOL_ID,
        entrypoint=ENTRYPOINT,
        purpose="Record and release exact ownership of Runner source workspaces without changing source, Git refs or remote state.",
        safe_first_calls=[{"label": "usage-json", "cmd": f"{ENTRYPOINT} usage --format json"}],
        verbs=[
            ToolVerb("usage", "none", "Describe the complete interface without inspecting a repository."),
            ToolVerb("bind", "local binding-state write", "Bind one Runner owner to the exact workspace, repository and incorporated base."),
            ToolVerb("release-binding", "local binding-state removal", "Remove the exact owner's empty binding; retain workspace and ordinary Git history."),
        ],
        selectors=[
            ToolSelector("--root", False, "Target Git workspace; defaults to the current directory."),
            ToolSelector("--state-root", False, "Explicit local binding-state directory."),
            ToolSelector("--binding-id", True, "Exact identity required by bind and release-binding."),
            ToolSelector("--owner-id", True, "Exact Runner identity required by bind and release-binding."),
            ToolSelector("--base", True, "Bind requires an exact incorporated commit SHA."),
            ToolSelector("--owned-path", False, "Repeatable exact repository-relative owned file for bind."),
        ],
        output_formats=["text", "json"],
        side_effects={
            "writes_repo": False,
            "modifies_remote": False,
            "network_access": "none; origin URL is read locally for a hashed repository identity",
            "writes_paths": ["local binding state under --state-root or the user state directory"],
            "danger_level": "low",
            "supports_dry_run": False,
            "workspace_lifecycle": "Runner retains creation, verified source handoff and removal ownership",
        },
        command_details=argparse_command_details(_parser(), semantics={
            "bind": {
                "prerequisites": ["The target is a Git workspace with an origin remote and the exact base commit is incorporated.", "The Runner owner and exact file ownership are known."],
                "retry": "Reusing the same binding, workspace and owner is idempotent. A different owner or workspace is rejected.",
            },
            "release-binding": {
                "prerequisites": ["Runner has completed verified source handoff and the workspace still exists.", "The original exact owner identity is known."],
                "retry": "A missing binding means no binding metadata remains to release; do not substitute another identity.",
            },
        }),
        examples=[
            {"label": "Bind a Runner worktree", "cmd": f"{ENTRYPOINT} --root <workspace> bind --binding-id <binding> --owner-id <run/group/item/attempt> --base <commit-sha> --lifecycle-owner runner --owned-path <file> --format json"},
            {"label": "Release after source handoff", "cmd": f"{ENTRYPOINT} --root <workspace> release-binding --binding-id <binding> --owner-id <run/group/item/attempt> --format json"},
        ],
        docs=["docs/source-workspaces.md"],
        errors=[
            {"code": "invalid_arguments", "meaning": "A required selector, valid choice or option value is missing."},
            {"code": "core_error", "meaning": "A precise ownership, identity, path, Git or state error is included in the result."},
            {"code": "io_error", "meaning": "A local file or process operation failed."},
        ],
        extra={"exit_codes": {"0": "operation completed or usage returned", "2": "arguments or operation failed"}},
    )


def _normalize_globals(raw: Sequence[str]) -> list[str]:
    globals_: list[str] = []
    remainder: list[str] = []
    index = 0
    while index < len(raw):
        token = raw[index]
        name = token.split("=", 1)[0]
        if name in GLOBAL_OPTIONS:
            globals_.append(token)
            if "=" not in token:
                if index + 1 >= len(raw) or raw[index + 1].startswith("--"):
                    raise _UsageError(f"{name} requires a value")
                globals_.append(raw[index + 1])
                index += 1
        else:
            remainder.append(token)
        index += 1
    return globals_ + remainder


def _requested_format(raw: Sequence[str]) -> str:
    result = "text"
    for index, token in enumerate(raw):
        value = token.partition("=")[2] if token.startswith("--format=") else (
            raw[index + 1] if token == "--format" and index + 1 < len(raw) else None
        )
        if value in {"text", "json"}:
            result = value
    return result


def _emit(payload: dict[str, Any], output_format: str, *, stream: TextIO) -> None:
    emit_payload(payload, output_format=output_format, stream=stream)
    if output_format == "text" and payload.get("schema_version") == "tool_result.v1":
        if payload.get("data"):
            stream.write("data:\n" + json.dumps(payload["data"], indent=2, sort_keys=True) + "\n")
        for error in payload.get("errors", []):
            if error.get("retry_hint"):
                stream.write(f"retry: {error['retry_hint']}\n")
            if error.get("details"):
                stream.write("details:\n" + json.dumps(error["details"], indent=2, sort_keys=True) + "\n")


def main(argv: Sequence[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    output_format = _requested_format(raw)
    verb = "usage"
    try:
        args = _parser().parse_args(_normalize_globals(raw))
        output_format = args.format
        verb = args.verb or "usage"
        if verb == "usage":
            _emit(usage_payload(), output_format, stream=sys.stdout)
            return 0
        # Usage does not construct this state owner or inspect any repository.
        from .core import ConcurrentDevelopment, ConcurrentDevelopmentError

        try:
            service = ConcurrentDevelopment(Path(args.root), state_root=Path(args.state_root) if args.state_root else None)
            if verb == "bind":
                data = service.bind(args.binding_id, args.owner_id, args.base, lifecycle_owner=args.lifecycle_owner, owned_paths=args.owned_path)
            else:
                data = service.release_binding(args.binding_id, args.owner_id)
        except ConcurrentDevelopmentError as error:
            payload = tool_result_payload(
                tool_id=TOOL_ID, verb=verb, status="error", summary=error.message,
                errors=[{"code": error.code, "message": error.message, "details": error.details,
                         "retry_hint": "Inspect the reported owner, workspace and state; do not substitute identities or delete unresolved bindings."}],
            )
            _emit(payload, output_format, stream=sys.stdout if output_format == "json" else sys.stderr)
            return 2
        payload = tool_result_payload(
            tool_id=TOOL_ID, verb=verb, status="ok", summary=f"{verb} completed.", data=data,
        )
        _emit(payload, output_format, stream=sys.stdout)
        return 0
    except (_UsageError, OSError) as error:
        payload = tool_result_payload(
            tool_id=TOOL_ID, verb=verb, status="error", summary=str(error),
            errors=[{"code": "invalid_arguments" if isinstance(error, _UsageError) else "io_error",
                     "message": str(error), "retry_hint": f"Read `{ENTRYPOINT} usage --format json`; inspect current state before retrying a mutation."}],
        )
        _emit(payload, output_format, stream=sys.stdout if output_format == "json" else sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
