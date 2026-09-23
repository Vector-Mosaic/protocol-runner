"""Shared contracts for repo tool handshake and result payloads.

The executable tools live under ``scripts/**``. This module is intentionally
import-only: it gives those thin wrappers one place to build standard usage and
result envelopes without copying schema-shaped dictionaries everywhere.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any, Mapping, Sequence, TextIO


USAGE_SCHEMA_VERSION = "tool_usage.v1"
RESULT_SCHEMA_VERSION = "tool_result.v1"
HANDSHAKE_INTERFACE_VERSION = "tool_handshake.v1"


@dataclass(frozen=True)
class ToolVerb:
    name: str
    side_effects: str
    summary: str

    def to_payload(self) -> dict[str, str]:
        return {
            "name": self.name,
            "side_effects": self.side_effects,
            "summary": self.summary,
        }


@dataclass(frozen=True)
class ToolSelector:
    name: str
    required: bool
    summary: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "required": self.required,
            "summary": self.summary,
        }


def normalize_format(raw: str | None, *, json_alias: bool = False) -> str:
    """Return ``text`` or ``json`` from a user-facing format selector."""

    if json_alias:
        return "json"
    value = (raw or "text").strip().lower()
    if value not in {"text", "json"}:
        raise ValueError("format must be 'text' or 'json'")
    return value


def tool_usage_payload(
    *,
    tool_id: str,
    purpose: str,
    entrypoint: str,
    safe_first_calls: Sequence[Mapping[str, Any]],
    verbs: Sequence[ToolVerb | Mapping[str, Any]],
    selectors: Sequence[ToolSelector | Mapping[str, Any]],
    output_formats: Sequence[str],
    side_effects: Mapping[str, Any],
    examples: Sequence[Mapping[str, Any]],
    docs: Sequence[str],
    errors: Sequence[Mapping[str, Any]] | None = None,
    status: str = "ok",
    extra: Mapping[str, Any] | None = None,
    command_details: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a minimum ``tool_usage.v1`` payload."""

    payload: dict[str, Any] = {
        "schema_version": USAGE_SCHEMA_VERSION,
        "tool_id": tool_id,
        "status": status,
        "purpose": purpose,
        "entrypoint": entrypoint,
        "safe_first_calls": [dict(item) for item in safe_first_calls],
        "verbs": [
            item.to_payload() if isinstance(item, ToolVerb) else dict(item)
            for item in verbs
        ],
        "selectors": [
            item.to_payload() if isinstance(item, ToolSelector) else dict(item)
            for item in selectors
        ],
        "output_formats": list(output_formats),
        "side_effects": dict(side_effects),
        "examples": [dict(item) for item in examples],
        "docs": list(docs),
        "errors": [dict(item) for item in errors or []],
    }
    if command_details is not None:
        payload["command_details"] = [dict(item) for item in command_details]
    if extra:
        payload.update(dict(extra))
    return payload


def argparse_command_details(
    parser: argparse.ArgumentParser,
    *,
    semantics: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Describe declared arguments without parsing or invoking a command.

    Tool authors still own prerequisites, effects, authority, errors and examples.
    Only explicitly safe public defaults belong in a help parser; this helper
    does not read configuration, environment values or credential stores. The
    argument metadata is a projection of argparse's declarations, not a second
    parser. ``semantics`` is keyed by the complete subcommand path.
    """

    details: list[dict[str, Any]] = []

    def visit(
        current: argparse.ArgumentParser,
        name: str,
        inherited: dict[str, dict[str, Any]],
        inherited_constraints: list[dict[str, Any]],
    ) -> None:
        parameters = {key: dict(value) for key, value in inherited.items()}
        children: list[argparse._SubParsersAction] = []
        for action in current._actions:
            if isinstance(action, argparse._SubParsersAction):
                children.append(action)
                continue
            if isinstance(action, argparse._HelpAction) or action.help == argparse.SUPPRESS:
                continue
            positional = not action.option_strings
            parameter = {
                "name": action.option_strings[0] if action.option_strings else action.dest,
                "required": action.required if not positional else action.nargs not in ("?", "*"),
                "summary": str(action.help or ""),
            }
            if len(action.option_strings) > 1:
                parameter["aliases"] = list(action.option_strings[1:])
            parameter["type"] = (
                "boolean" if isinstance(action, (argparse._StoreTrueAction, argparse._StoreFalseAction, argparse.BooleanOptionalAction))
                else getattr(action.type, "__name__", "string")
            )
            if action.nargs is not None:
                parameter["nargs"] = action.nargs
            default = action.default
            if default == argparse.SUPPRESS:
                if action.dest in inherited and "default" in inherited[action.dest]:
                    parameter["default"] = inherited[action.dest]["default"]
            else:
                try:
                    json.dumps(default)
                except (TypeError, ValueError):
                    pass
                else:
                    parameter["default"] = default
            if action.choices is not None:
                parameter["choices"] = list(action.choices)
            parameters[action.dest] = parameter

        parser_constraints = list(inherited_constraints)
        for group in current._mutually_exclusive_groups:
            parser_constraints.append({
                "kind": "exactly_one" if group.required else "at_most_one",
                "parameters": [parameters[action.dest]["name"] for action in group._group_actions if action.dest in parameters],
            })
        if name:
            detail: dict[str, Any] = {
                "name": name,
                "syntax": " ".join(current.format_usage().strip().removeprefix("usage: ").split()),
                "parameters": list(parameters.values()),
            }
            constraints = list(parser_constraints)
            supplied = dict((semantics or {}).get(name, {}))
            constraints.extend(supplied.pop("constraints", []))
            if constraints:
                detail["constraints"] = constraints
            # Parser facts cannot be overridden by a second hand-maintained copy.
            detail.update({key: value for key, value in supplied.items() if key not in {"name", "syntax", "parameters"}})
            details.append(detail)
        for child_action in children:
            for child_name, child in child_action.choices.items():
                visit(child, f"{name} {child_name}".strip(), parameters, parser_constraints)

    visit(parser, "", {}, [])
    return details


def tool_result_payload(
    *,
    tool_id: str,
    verb: str,
    summary: str,
    data: Mapping[str, Any] | None = None,
    warnings: Sequence[Mapping[str, Any] | str] | None = None,
    errors: Sequence[Mapping[str, Any] | str] | None = None,
    status: str = "ok",
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a minimum ``tool_result.v1`` payload."""

    payload: dict[str, Any] = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "tool_id": tool_id,
        "status": status,
        "verb": verb,
        "summary": summary,
        "data": dict(data or {}),
        "warnings": [_normalize_message(item) for item in warnings or []],
        "errors": [_normalize_message(item) for item in errors or []],
    }
    if extra:
        payload.update(dict(extra))
    return payload


def format_usage_text(payload: Mapping[str, Any]) -> str:
    """Render compact, agent-facing usage text from a usage payload."""

    lines = [
        f"{payload.get('tool_id')}: {payload.get('purpose')}",
        f"entrypoint: {payload.get('entrypoint')}",
        "safe first calls:",
    ]
    for item in payload.get("safe_first_calls", []):
        if isinstance(item, Mapping):
            label = item.get("label", "call")
            cmd = item.get("cmd", "")
            lines.append(f"- {label}: {cmd}")
            for key, value in item.items():
                if key not in {"label", "cmd"}:
                    _append_usage_value(lines, key, value, indent=2)
    lines.append("verbs:")
    for item in payload.get("verbs", []):
        if isinstance(item, Mapping):
            lines.append(f"- {item.get('name')}: {item.get('summary')}")
            for key, value in item.items():
                if key not in {"name", "summary"}:
                    _append_usage_value(lines, key, value, indent=2)
    selectors = payload.get("selectors", [])
    if selectors:
        lines.append("selectors:")
        for item in selectors:
            if isinstance(item, Mapping):
                required = "required" if item.get("required") else "optional"
                lines.append(f"- {item.get('name')} ({required}): {item.get('summary')}")
                for key, value in item.items():
                    if key not in {"name", "required", "summary"}:
                        _append_usage_value(lines, key, value, indent=2)
    output_formats = ", ".join(str(item) for item in payload.get("output_formats", []))
    if output_formats:
        lines.append(f"output formats: {output_formats}")
    for key in ("side_effects", "command_details", "examples", "errors"):
        if key in payload:
            _append_usage_value(lines, key, payload[key])
    docs = payload.get("docs", [])
    if docs:
        lines.append("docs:")
        for doc in docs:
            lines.append(f"- {doc}")
    known = {"schema_version", "tool_id", "status", "purpose", "entrypoint", "safe_first_calls", "verbs", "selectors", "output_formats", "side_effects", "command_details", "examples", "errors", "docs"}
    for key, value in payload.items():
        if key not in known:
            _append_usage_value(lines, key, value)
    return "\n".join(lines) + "\n"


def _append_usage_value(lines: list[str], label: str, value: Any, *, indent: int = 0) -> None:
    """Keep nested public declarations visible in text as well as JSON."""

    if value == [] or value == {}:
        return
    prefix = " " * indent
    if isinstance(value, Mapping):
        lines.append(f"{prefix}{label}" + (":" if label != "-" else ""))
        for key, child in value.items():
            _append_usage_value(lines, str(key), child, indent=indent + 2)
    elif isinstance(value, (list, tuple)):
        lines.append(f"{prefix}{label}:")
        for child in value:
            _append_usage_value(lines, "-", child, indent=indent + 2)
    else:
        rendered = json.dumps(value) if value is None or isinstance(value, (bool, int, float)) or value == "" else str(value)
        lines.append(f"{prefix}{label}: {rendered}")


def format_result_text(payload: Mapping[str, Any]) -> str:
    """Render compact text for a result envelope."""

    lines = [
        f"{payload.get('tool_id')} {payload.get('verb')}: {payload.get('status')}",
        str(payload.get("summary") or ""),
    ]
    warnings = payload.get("warnings") or []
    if warnings:
        lines.append("warnings:")
        for item in warnings:
            if isinstance(item, Mapping):
                lines.append(f"- {item.get('code', 'warning')}: {item.get('message')}")
            else:
                lines.append(f"- {item}")
    errors = payload.get("errors") or []
    if errors:
        lines.append("errors:")
        for item in errors:
            if isinstance(item, Mapping):
                lines.append(f"- {item.get('code', 'error')}: {item.get('message')}")
            else:
                lines.append(f"- {item}")
    return "\n".join(line for line in lines if line != "") + "\n"


def emit_payload(payload: Mapping[str, Any], *, output_format: str, stream: TextIO) -> None:
    """Write a usage/result payload as text or JSON."""

    if output_format == "json":
        stream.write(json.dumps(payload, indent=2, sort_keys=True))
        stream.write("\n")
        return
    schema_version = str(payload.get("schema_version") or "")
    if schema_version == USAGE_SCHEMA_VERSION:
        stream.write(format_usage_text(payload))
    else:
        stream.write(format_result_text(payload))


def _normalize_message(item: Mapping[str, Any] | str) -> dict[str, Any]:
    if isinstance(item, Mapping):
        return dict(item)
    return {"code": "message", "message": str(item)}
