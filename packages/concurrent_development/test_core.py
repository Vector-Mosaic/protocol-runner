"""Focused integration checks for the extracted Runner binding lifecycle."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from .core import ConcurrentDevelopment, ConcurrentDevelopmentError


RUNNER_ROOT = Path(__file__).resolve().parents[2]
HELPER = RUNNER_ROOT / "scripts" / "tools" / "concurrent_development.py"


class SourceWorkspaceBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="runner-binding-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / "target"
        self.state = self.directory / "state"
        self.root.mkdir()
        self.git(self.root, "init")
        self.git(self.root, "config", "user.name", "Runner fixture")
        self.git(self.root, "config", "user.email", "runner@example.invalid")
        self.git(self.root, "config", "commit.gpgsign", "false")
        hooks = self.directory / "empty-hooks"
        hooks.mkdir()
        self.git(self.root, "config", "core.hooksPath", str(hooks))
        self.git(self.root, "remote", "add", "origin", "https://example.invalid/runner/fixture.git")
        (self.root / "owned.txt").write_text("original\n", encoding="utf-8")
        self.git(self.root, "add", "owned.txt")
        self.git(self.root, "commit", "-m", "fixture")
        self.base = self.git(self.root, "rev-parse", "HEAD")

    @staticmethod
    def git(root: Path, *arguments: str) -> str:
        environment = os.environ.copy()
        for key in ("GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
            environment.pop(key, None)
        result = subprocess.run(
            ["git", "-C", str(root), *arguments], check=True, capture_output=True,
            text=True, encoding="utf-8", env=environment,
        )
        return result.stdout.strip()

    def service(self, root: Path | None = None) -> ConcurrentDevelopment:
        return ConcurrentDevelopment(root or self.root, self.state)

    def assert_error(self, code: str, operation) -> None:
        with self.assertRaises(ConcurrentDevelopmentError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    def test_bind_release_preserves_dirty_source_index_and_history(self) -> None:
        service = self.service()
        (self.root / "owned.txt").write_text("worker change\n", encoding="utf-8")
        before_status = self.git(self.root, "status", "--porcelain=v1")
        before_index = self.git(self.root, "write-tree")
        bound = service.bind("binding", "run/group/item/attempt", self.base, owned_paths=["owned.txt"])
        self.assertEqual(bound["base"], self.base)
        self.assertEqual(bound["owned_paths"], ["owned.txt"])
        self.assertEqual(bound["lifecycle_owner"], "runner")
        # A retry recovers the existing record, never silently changes ownership.
        self.assertEqual(service.bind("binding", "run/group/item/attempt", self.base), bound)
        result = service.release_binding("binding", "run/group/item/attempt")
        self.assertFalse(result["workspace_removed"])
        self.assertEqual((self.root / "owned.txt").read_text(encoding="utf-8"), "worker change\n")
        self.assertEqual(self.git(self.root, "status", "--porcelain=v1"), before_status)
        self.assertEqual(self.git(self.root, "write-tree"), before_index)
        self.assertEqual(self.git(self.root, "rev-parse", "HEAD"), self.base)
        self.assert_error("binding_missing", lambda: service.release_binding("binding", "run/group/item/attempt"))

    def test_owner_and_workspace_collisions_are_rejected(self) -> None:
        service = self.service()
        service.bind("binding", "owner", self.base)
        self.assert_error("binding_owned", lambda: service.bind("binding", "other", self.base))
        self.assert_error("binding_owned", lambda: service.release_binding("binding", "other"))
        self.assert_error("workspace_already_bound", lambda: service.bind("another-binding", "other", self.base))
        other = self.directory / "clone"
        self.git(self.root, "clone", "--no-hardlinks", str(self.root), str(other))
        self.git(other, "remote", "set-url", "origin", "https://example.invalid/runner/fixture.git")
        self.assert_error("binding_mismatch", lambda: self.service(other).bind("binding", "owner", self.base))
        service.release_binding("binding", "owner")

    def test_exact_incorporated_base_and_contained_file_paths_are_required(self) -> None:
        service = self.service()
        self.assert_error("exact_oid_required", lambda: service.bind("binding", "owner", "HEAD"))
        unrelated = self.git(self.root, "commit-tree", f"{self.base}^{{tree}}", "-m", "unrelated root")
        self.assert_error("base_not_incorporated", lambda: service.bind("binding", "owner", unrelated))
        self.assert_error("invalid_path", lambda: service.bind("binding", "owner", self.base, owned_paths=["../outside.txt"]))
        folder = self.root / "folder"
        folder.mkdir()
        self.assert_error("file_paths_required", lambda: service.bind("binding", "owner", self.base, owned_paths=["folder"]))

    def test_origin_required_and_foreign_pending_state_is_not_repaired(self) -> None:
        self.git(self.root, "remote", "remove", "origin")
        self.assert_error("origin_required", self.service)
        self.git(self.root, "remote", "add", "origin", "https://example.invalid/runner/fixture.git")
        service = self.service()
        bound = service.bind("binding", "owner", self.base)
        bound["pending_local_ref"] = {"new": self.base}
        record = service.directory / "binding.json"
        record.write_text(json.dumps(bound), encoding="utf-8")
        self.assert_error("foreign_integration_state", lambda: service.release_binding("binding", "owner"))
        self.assertTrue(record.exists())
        self.assertEqual(self.git(self.root, "show-ref"), f"{self.base} refs/heads/{self.git(self.root, 'branch', '--show-current')}")

    def test_installed_helper_json_does_not_require_target_copy_or_expose_origin(self) -> None:
        self.git(self.root, "remote", "set-url", "origin", "https://user:do-not-print@example.invalid/runner/fixture.git")
        self.assertFalse((self.root / "scripts" / "tools" / "concurrent_development.py").exists())
        arguments = [sys.executable, "-B", str(HELPER), "--root", str(self.root), "--state-root", str(self.state)]
        result = subprocess.run(
            arguments + ["bind", "--binding-id", "binding", "--owner-id", "owner", "--base", self.base,
                         "--lifecycle-owner", "runner", "--owned-path", "owned.txt", "--format", "json"],
            capture_output=True, text=True, encoding="utf-8", cwd=self.directory,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ok")
        self.assertNotIn("do-not-print", result.stdout + result.stderr)
        self.assertNotIn("example.invalid", result.stdout + result.stderr)
        released = subprocess.run(
            arguments + ["release-binding", "--binding-id", "binding", "--owner-id", "owner", "--format", "json"],
            capture_output=True, text=True, encoding="utf-8", cwd=self.directory,
        )
        self.assertEqual(released.returncode, 0, released.stderr)
        self.assertEqual(json.loads(released.stdout)["data"]["status"], "binding_released")


if __name__ == "__main__":
    unittest.main()
