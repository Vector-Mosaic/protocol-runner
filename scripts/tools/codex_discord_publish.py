#!/usr/bin/env python
"""Publish a Codex self-report message through the local Discord desktop relay."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
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


TOOL_ID = "tool.dev_helper.codex_discord_publish"
ENTRYPOINT = "python scripts/tools/codex_discord_publish.py"
DEFAULT_SECRET_ENV_FILE = REPO_ROOT / ".env.desktop.local"
DEFAULT_BASE_URL = "http://127.0.0.1:14830"
DEFAULT_SECRET_KEY = "WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_PUBLISH_BEARER_TOKEN"


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_publish_secret(secret_env_file: Path, secret_key: str) -> str:
    value = os.environ.get(secret_key, "").strip()
    if value:
        return value

    file_values = read_env_file(secret_env_file)
    value = file_values.get(secret_key, "").strip()
    if value:
        return value

    raise SystemExit(f"Missing publish bearer token in environment or {secret_env_file}: {secret_key}")


def read_text(args: argparse.Namespace) -> str:
    if args.text is not None:
        return args.text
    if getattr(args, "stdin", False):
        return sys.stdin.read()

    return Path(args.text_file).read_text(encoding="utf-8")


def post_publish(base_url: str, bearer_token: str, payload: dict[str, str]) -> dict[str, object]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/publish",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {bearer_token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_text = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Publish failed: HTTP {error.code} {response_text}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Publish failed: {error}") from error


def _usage_payload() -> dict[str, object]:
    return tool_usage_payload(
        tool_id=TOOL_ID,
        purpose="Publish or dry-run a final visible Codex self-report through the local Discord desktop relay.",
        entrypoint=ENTRYPOINT,
        safe_first_calls=[
            {"label": "usage", "cmd": ENTRYPOINT},
            {"label": "usage-json", "cmd": f"{ENTRYPOINT} usage --format json"},
            {"label": "preview", "cmd": f"{ENTRYPOINT} preview --channel-id <discord-channel-id> --binding-id <active-binding-id> --text \"final visible response\" --format json"},
        ],
        verbs=[
            ToolVerb("usage", "none", "Return this compact usage contract."),
            ToolVerb("preview", "none", "Use --dry-run to validate text source, channel id, binding id, and output hash without contacting the relay."),
            ToolVerb("publish", "Discord publish", "Publish the provided final visible response through the local relay."),
        ],
        selectors=[
            ToolSelector("--channel-id", True, "Discord text channel id to publish into."),
            ToolSelector("--binding-id", True, "Active relay binding id for the Codex thread."),
            ToolSelector("--text / --text-file / --stdin", True, "Exactly one source for the final visible assistant response."),
            ToolSelector("--dry-run", False, "Preview payload metadata without posting to Discord or reading a bearer token."),
            ToolSelector("--base-url", False, f"Relay base URL. Default: {DEFAULT_BASE_URL}."),
            ToolSelector("--secret-env-file", False, "Local secrets env file for the publish bearer token."),
            ToolSelector("--correlation-id", False, "Optional secret-free correlation id."),
        ],
        output_formats=["text", "json"],
        side_effects={
            "writes_repo": False,
            "writes_paths": [],
            "modifies_remote": "publish posts message chunks to Discord through the local relay",
            "network_access": "loopback_http_to_local_relay_and_discord_api_via_service",
            "danger_level": "medium",
            "supports_dry_run": True,
            "preview_or_plan_verbs": ["--dry-run"],
            "notification_policy": "Publish only the final visible assistant response. Do not publish progress updates, tool logs, hidden reasoning, or binding notes.",
        },
        examples=[
            {"label": "Usage JSON", "cmd": f"{ENTRYPOINT} usage --format json"},
            {
                "label": "Dry run",
                "cmd": f"{ENTRYPOINT} preview --channel-id <discord-channel-id> --binding-id <active-binding-id> --text-file <path-to-final-response.txt> --format json",
            },
            {
                "label": "Publish",
                "cmd": f"{ENTRYPOINT} publish --channel-id <discord-channel-id> --binding-id <active-binding-id> --text-file <path-to-final-response.txt>",
            },
        ],
        docs=["docs/windows-desktop.md"],
        errors=[
            {"code": "missing_publish_secret", "meaning": "Publish requires the local publish bearer token."},
            {"code": "relay_unavailable", "meaning": "The local relay API could not be reached or rejected the publish request."},
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


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "verb",
        nargs="?",
        choices=("preview", "publish"),
        default="publish",
        help="Use preview for a no-post dry run, or publish to post through the local relay.",
    )
    parser.add_argument("--channel-id", required=True, help="Discord text channel id to publish into.")
    parser.add_argument("--binding-id", required=True, help="Active relay binding id for the Codex thread.")
    text_group = parser.add_mutually_exclusive_group(required=True)
    text_group.add_argument("--text", help="Text to publish.")
    text_group.add_argument("--text-file", help="UTF-8 text file to publish.")
    text_group.add_argument("--stdin", action="store_true", help="Read UTF-8 text to publish from stdin.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Relay base URL. Default: {DEFAULT_BASE_URL}")
    parser.add_argument(
        "--secret-env-file",
        default=str(DEFAULT_SECRET_ENV_FILE),
        help="Local secrets env file containing the publish bearer token.",
    )
    parser.add_argument("--secret-key", default=DEFAULT_SECRET_KEY, help="Secret key name for the bearer token.")
    parser.add_argument("--source", default="codex-desktop-self-report", help="Secret-free source label.")
    parser.add_argument("--correlation-id", default=None, help="Optional secret-free correlation id.")
    parser.add_argument("--dry-run", action="store_true", help="Validate publish metadata without contacting the relay.")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Output format for --dry-run.")
    parser.add_argument("--json", action="store_true", help="Alias for --format json when used with --dry-run.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    if _is_usage_request(argv):
        emit_payload(_usage_payload(), output_format=_usage_format(argv), stream=sys.stdout)
        return 0

    args = parse_args(argv)
    if args.verb == "preview":
        args.dry_run = True
    text = read_text(args)
    if args.dry_run:
        payload = tool_result_payload(
            tool_id=TOOL_ID,
            verb="preview",
            summary="Dry run only; the relay was not contacted and text was not published.",
            data={
                "dry_run": True,
                "channel_id": args.channel_id,
                "binding_id": args.binding_id,
                "source": args.source,
                "correlation_id": args.correlation_id,
                "text_length": len(text),
                "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "would_contact_relay": False,
                "would_publish_if_not_dry_run": True,
            },
        )
        if normalize_format(args.format, json_alias=args.json) == "json":
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            data = payload["data"]
            print(
                "dry_run",
                f"channel_id={data['channel_id']}",
                f"binding_id={data['binding_id']}",
                f"text_length={data['text_length']}",
                f"text_sha256={data['text_sha256']}",
            )
        return 0

    bearer_token = read_publish_secret(Path(args.secret_env_file), args.secret_key)
    payload = {
        "channelId": args.channel_id,
        "bindingId": args.binding_id,
        "text": text,
        "source": args.source,
    }
    if args.correlation_id:
        payload["correlationId"] = args.correlation_id

    result = post_publish(args.base_url, bearer_token, payload)
    print(
        "published",
        f"channel_id={result.get('channelId')}",
        f"chunks={result.get('chunkCount')}",
        f"message_ids={','.join(result.get('messageIds', []))}",
        f"text_sha256={result.get('textSha256')}",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
