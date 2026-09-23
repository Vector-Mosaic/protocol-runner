"""Runner-owned Git workspace bindings, extracted from the source integration owner.

The executor owns workspace creation, source handoff and cleanup. This module
only records or releases the exact owner/repository/workspace/base relationship.
It does not merge, publish, fetch, alter Git refs or delete workspaces.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, Mapping, Sequence


SCHEMA = "wc.concurrent_binding.v1"
REMOTE = "origin"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_OID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")


class ConcurrentDevelopmentError(RuntimeError):
    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def _fail(code: str, message: str, **details: Any) -> None:
    raise ConcurrentDevelopmentError(code, message, **details)


def _json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        _fail("invalid_identity", "Use an exact bounded owner/binding/job identifier.")
    return value


def _git(root: Path, args: Sequence[str], *, data: bytes | None = None,
         index: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    environment = os.environ.copy()
    for key in ("GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        environment.pop(key, None)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    if index is not None:
        environment["GIT_INDEX_FILE"] = str(index)
    try:
        result = subprocess.run(["git", "--literal-pathspecs", "-C", str(root), *args],
                                input=data, capture_output=True, env=environment, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        _fail("git_unavailable", "Git could not complete the selected operation.", operation=args[0])
    if check and result.returncode:
        # Provider diagnostics can contain credential-bearing remote URLs.
        _fail("git_failed", "Git refused the selected operation; original source is preserved.",
              operation=args[0], exit_code=result.returncode)
    return result


def _text(root: Path, args: Sequence[str], **kwargs: Any) -> str:
    return _git(root, args, **kwargs).stdout.decode("utf-8", "surrogateescape").strip()


def _oid(root: Path, value: str, kind: str = "commit") -> str:
    if not isinstance(value, str) or not _OID.fullmatch(value):
        _fail("exact_oid_required", "An exact commit/tree identity is required.")
    actual = _text(root, ["rev-parse", "--verify", f"{value}^{{{kind}}}"])
    if not _OID.fullmatch(actual):
        _fail("invalid_object", "Git object identity could not be established.")
    return actual


def _safe_path(root: Path, raw: str) -> str:
    if not isinstance(raw, str) or "\\" in raw or "\0" in raw or "\n" in raw:
        _fail("invalid_path", "Source paths must be literal repository-relative file paths.")
    path = PurePosixPath(raw)
    if path.is_absolute() or not path.parts or any(p.lower() in {".", "..", ".git"} for p in path.parts):
        _fail("invalid_path", "Source paths must stay inside the selected workspace.")
    if any(":" in part for part in path.parts):
        _fail("invalid_path", "Absolute or pathspec source selectors are not supported.")
    candidate = root.joinpath(*path.parts)
    for parent in candidate.parents:
        if parent == root:
            break
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            _fail("unsafe_path", "Source paths cannot traverse symbolic-link or junction parents.")
    if candidate.is_dir() and not candidate.is_symlink():
        _fail("file_paths_required", "Select exact files; directory expansion is not implicit.")
    return path.as_posix()


def _atomic_write(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".binding-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_json(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def _lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            _fail("binding_busy", "Another operation currently owns this integration binding.")
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class ConcurrentDevelopment:
    def __init__(self, root: Path, state_root: Path | None = None):
        self.root = Path(_text(Path(root).resolve(), ["rev-parse", "--show-toplevel"])).resolve()
        self.common = Path(_text(self.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).resolve()
        url = _text(self.root, ["remote", "get-url", REMOTE], check=False)
        if not url:
            _fail("origin_required", "Configure an origin remote to identify this source repository; the binding helper does not contact it.")
        normalized = re.sub(r"^git@([^:]+):", r"ssh://\1/", url).rstrip("/")
        normalized = re.sub(r"^(?:https?|ssh)://(?:git@)?", "", normalized)
        normalized = normalized.removesuffix(".git")
        self.repository = hashlib.sha256(normalized.encode()).hexdigest()
        default = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local" / "state")))
        self.state_root = (Path(state_root) if state_root else default / "ProtocolRunner" / "source-workspaces")
        self.directory = self.state_root.resolve() / self.repository

    def _file(self, binding_id: str) -> Path:
        return self.directory / f"{_identifier(binding_id)}.json"

    @contextlib.contextmanager
    def _locked(self, binding_id: str) -> Iterator[dict[str, Any]]:
        with _lock(self._file(binding_id).with_suffix(".lock")):
            binding = self._load(binding_id)
            if binding.get("refresh_operation") or binding.get("pending_local_ref"):
                _fail("foreign_integration_state", "This binding contains unfinished integration state owned by another tool; resolve it with that owner.")
            yield binding

    def _load(self, binding_id: str) -> dict[str, Any]:
        try:
            value = json.loads(self._file(binding_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _fail("binding_missing", "The exact integration binding is missing or unreadable.")
        if (value.get("schema") != SCHEMA or value.get("binding_id") != binding_id or
                value.get("repository") != self.repository or
                value.get("workspace") != self.root.as_posix() or
                value.get("git_common_dir") != self.common.as_posix()):
            _fail("binding_mismatch", "The binding does not belong to this exact workspace and repository.")
        return value

    def _save(self, binding: dict[str, Any]) -> None:
        _atomic_write(self._file(binding["binding_id"]), binding)

    def _head(self) -> str:
        return _text(self.root, ["rev-parse", "HEAD"])

    def _included(self, commit: str, observed: str) -> bool:
        return _git(self.root, ["merge-base", "--is-ancestor", commit, observed], check=False).returncode == 0

    def bind(self, binding_id: str, owner_id: str, base: str, lifecycle_owner: str = "runner",
             owned_paths: Sequence[str] = ()) -> dict[str, Any]:
        _identifier(binding_id)
        if not owner_id or len(owner_id) > 512 or any(ord(c) < 32 for c in owner_id):
            _fail("invalid_owner", "An actual task or Runner attempt identity is required.")
        if lifecycle_owner != "runner":
            _fail("invalid_lifecycle_owner", "This helper supports Runner-owned source workspaces only.")
        base = _oid(self.root, base)
        if not self._included(base, self._head()):
            _fail("base_not_incorporated", "The declared base is not in this workspace's ordinary Git history.")
        paths = sorted({_safe_path(self.root, p) for p in owned_paths})
        with _lock(self.directory / "bindings.lock"):
            if self._file(binding_id).exists():
                value = self._load(binding_id)
                if value["owner_id"] != owner_id or value["lifecycle_owner"] != lifecycle_owner:
                    _fail("binding_owned", "This integration binding already belongs to another owner.")
                return value
            for path in self.directory.glob("*.json"):
                try:
                    other = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    _fail("binding_unreadable", "An existing workspace binding needs repair before adding another.")
                if other.get("workspace") == self.root.as_posix():
                    _fail("workspace_already_bound", "This mutable workspace already has an integration owner.")
            value = {"schema": SCHEMA, "binding_id": binding_id, "owner_id": owner_id,
                     "repository": self.repository, "workspace": self.root.as_posix(),
                     "git_common_dir": self.common.as_posix(), "lifecycle_owner": lifecycle_owner,
                     "base": base, "generation": 0, "owned_paths": paths, "candidate": None}
            self._save(value)
            return value

    def release_binding(self, binding_id: str, owner_id: str) -> dict[str, Any]:
        with self._locked(binding_id) as binding:
            if binding["owner_id"] != owner_id:
                _fail("binding_owned", "Only the exact lifecycle owner may release this workspace binding.")
            if binding.get("candidate") is not None:
                _fail("candidate_unfinished", "This binding has an unfinished integration candidate; close it with its original owner before release.")
            self._file(binding_id).unlink()
            return {"status": "binding_released", "binding_id": binding_id, "workspace_removed": False}
