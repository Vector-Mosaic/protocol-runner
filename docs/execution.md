# Execution profiles

The default executor uses **fake workers**, capacity **1**, and launch batch size
**1**. It runs the real lease, attempt, output and recovery machinery without
calling a model. Fake results are demonstration evidence, not model results.

Live execution is a separate choice: set
`PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE=codex_exec` and an explicit
`PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT`. The repository launcher makes
those choices through its live profile. Authenticate the installed Codex CLI
before starting it. Actual model calls can consume your account's usage.

The launcher passes `--sandbox workspace-write` and
`-c approval_policy="never"`. It preserves your Codex model/profile configuration.
If the selected platform cannot run that sandbox, execution fails; Runner does
not retry with broader access. Deliberate `CODEX_SANDBOX` or bypass configuration
remains available through the executor's explicitly named environment settings,
but is never the default. Do not describe runs made with those overrides as
sandboxed. An operating-system sandbox is provided by Codex, not by Runner.

The API's runs directory must be inside the selected live workspace so a worker
can write its own status report. Source writers use a detached worktree and also
receive write access to their exact enclosing attempt directory for that report.
They do not receive a broad extra directory grant. See
[source workspaces](source-workspaces.md) for source handoff and recovery.

## API and worker credentials

The executor authenticates to the loopback API with a control token from
`PROTOCOL_RUNNER_CONTROL_TOKEN`, `PROTOCOL_RUNNER_CONTROL_TOKEN_FILE`, or the
installed repository's `.protocol-runner/control-token`. The token must have at
least 32 characters. The API client rejects off-host URLs, URL credentials,
non-root paths, query strings, fragments and redirects. Tokens are never written
to worker packets or logs by the executor.

Worker processes receive an allowlist of ordinary OS path/home/temp/locale
variables, Codex home and provider credentials (`OPENAI_API_KEY` and
`CODEX_API_KEY`), and certificate paths. Explicitly configured runtime tool paths
are then added. Runner's control token, GitHub tokens, database credentials,
`NODE_OPTIONS`, `PYTHONPATH`, and arbitrary service environment variables are
not inherited. This does not isolate files readable by the local OS account,
including the user's Codex configuration; use a separate account or machine for
untrusted work.

## Advanced settings

All executor settings have the `PROTOCOL_RUNNER_PARALLEL_EXECUTOR_` prefix:

| Setting | Default / meaning |
| --- | --- |
| `MODE` | `fake`; choose `codex_exec` deliberately |
| `WORKSPACE_ROOT` | Required for `codex_exec` |
| `CAPACITY`, `LAUNCH_BATCH_SIZE` | Both `1` |
| `CODEX_COMMAND` | `codex` |
| `CODEX_MODEL`, `CODEX_PROFILE` | Optional user choices |
| `CODEX_SANDBOX` | `workspace-write` |
| `CODEX_BYPASS_APPROVALS_AND_SANDBOX` | `false` |
| `WORKER_NODE_EXE`, `WORKER_PNPM_CMD`, `WORKER_PYTHON_EXE` | Explicit usable tool paths |
| `WORKER_PATH_PREPEND` | Optional platform-delimited tool directories |
| `HARD_TIMEOUT_MS` | Optional; an elapsed-time cutoff is not a quality judgment |

The source-integration helper comes from the installed Runner repository rather
than the target project's scripts. `PROTOCOL_RUNNER_SOURCE_INTEGRATION_COMMAND`
can select a compatible helper explicitly.

Foreground startup shuts down the executor over IPC with `{ "type": "shutdown" }`.
It stops requesting leases, cancels only its own active worker processes, waits
for their evidence and result submission, then exits. The API must remain alive
until that exit. SIGINT/SIGTERM request the same cleanup from the executor itself;
for a parent process on Windows, use IPC rather than forcibly terminating Node.
An interrupted attempt remains visible for explicit recovery.

## Smoke programs

The preserved smoke programs are developer tools, not part of ordinary startup.
The smoke ladder defaults to fake workers. Pass `--live` to admit real rungs;
larger rungs require their additional explicit switches. Runtime-profile and
process-control smokes also require `--live`. Timing and recovery smokes use
local deterministic worker fixtures. No smoke program defaults to bypassing
Codex approvals and sandboxing. Run them only in a workspace and account whose
resource use and outputs you intend.

The smallest live qualification is one completion and one stop scenario:

```sh
node services/protocol-runner-parallel-executor/dist/smoke_ladder.js --live --rung real_1 --workspace /absolute/workspace
node services/protocol-runner-parallel-executor/dist/process_control_smoke.js --live --scenario stop --workspace /absolute/workspace
```

Use an existing trusted Git workspace. These two commands preserve the configured
Codex model/profile, force `workspace-write` without bypass, and limit each worker
to 120 seconds. Each uses one worker at a time. The stop scenario waits for the
real worker to write its readiness marker before stopping it; it checks the
resulting API state, retained cancellation evidence, and process termination.
Outputs go under the chosen workspace's `.protocol-runner/qualification/`.
Console output is a procedural summary; worker evidence stays in those ignored
local directories. Neither command evaluates the substantive quality of model
reasoning.

If more than one Codex CLI is installed, check the selected executable's version.
Set `PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_COMMAND` to its absolute path when
necessary; an older CLI may not support the model selected in your configuration.
Runner does not upgrade the CLI or substitute another model automatically.
Global Codex instructions and connected tools also remain active. A short smoke
timeout may be consumed by unrelated machine-specific onboarding; inspect the
retained attempt before deciding whether to retry with a suitable bound or profile.
