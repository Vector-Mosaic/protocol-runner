# Source-writing workers

The parallel executor can give a source-writing item an isolated Git worktree at
an exact base commit. That worktree belongs to one run, group, item and attempt.
The executor records the binding before launching the worker and releases it
after verified source handoff. The binding helper never creates or removes a
worktree, merges code, edits the target's index or refs, or publishes changes.

The helper is installed with Runner at
`scripts/tools/concurrent_development.py`. The target repository does **not**
need a copy of Runner or this script. The executor selects its installed helper;
`PROTOCOL_RUNNER_SOURCE_INTEGRATION_COMMAND` can select a deliberately installed
alternative. Its `--root` argument always identifies the target Git workspace.

Python 3.10 or newer and Git are required. No Python third-party dependencies
are needed. The target repository must have a locally configured `origin`
remote. The helper hashes the normalized origin URL to identify the repository;
it never contacts the remote or includes that URL in its results. Clones and
worktrees sharing that identity are still distinguished by their exact workspace
and Git common-directory paths. Changing origin while a binding exists changes
the identity under which the helper looks for that binding: keep it stable
through handoff and release.

Binding state is local to the user, outside source files. Its default location is
`%LOCALAPPDATA%/ProtocolRunner/source-workspaces` on Windows, or
`~/.local/state/ProtocolRunner/source-workspaces` elsewhere. `--state-root` can
select a separate state location; use the same one for binding and release.
This namespace is separate from the original monorepo integration tool's state.

## Ownership and handoff

The authored source-workspace policy and the executor own the source handoff.
The binding is an ownership record, not a filesystem sandbox or proof of code
quality. It does not limit arbitrary commands a worker can execute. Execution
permissions and allowed source paths must remain consistent with the concrete
worker contract and the executor's workspace checks.

The helper accepts only these commands:

```text
python /path/to/protocol-runner/scripts/tools/concurrent_development.py usage --format json
python /path/to/protocol-runner/scripts/tools/concurrent_development.py --root /path/to/worktree bind --binding-id exact-binding --owner-id run/group/item/attempt --base COMMIT_SHA --lifecycle-owner runner --owned-path src/owned-file.ts --format json
python /path/to/protocol-runner/scripts/tools/concurrent_development.py --root /path/to/worktree release-binding --binding-id exact-binding --owner-id run/group/item/attempt --format json
```

`bind` requires the full commit identity already incorporated in the worktree's
history. Owned paths are exact repository-relative files; directories are not
implicitly expanded. The helper rejects paths through symbolic-link or junction
parents, conflicting workspace owners, and reuse of a binding for a different
workspace or repository. Repeating a successful bind for the same identity and
owner returns the existing record, rather than silently changing its base or
owned files.

`release-binding` requires the original exact owner and an empty binding. It
removes only binding metadata, leaving source and the worktree in place for the
executor's lifecycle. A missing binding produces `binding_missing`; inspect the
prior result and actual executor handoff before treating an interrupted release
as complete. A foreign record containing an integration candidate or an unfinished
refresh is rejected and must be handled by its original owner.

This extraction retains the original binding identity, path validation, atomic
record writes and operating-system locks. The private repository's candidate
preparation, branch integration, remote publication and refresh commands are not
part of this public helper. Their absence does not replace the executor's own
verified handoff or authorize publishing worker changes.

## Focused verification

The standard-library tests exercise actual disposable Git repositories and
check owner rejection, base validation, workspace identity, file preservation and
the installed helper's JSON interface:

```text
python -B -m unittest packages.concurrent_development.test_core
```

They do not start workers, make model calls, access remotes or publish source.
