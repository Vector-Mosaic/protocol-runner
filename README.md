# Protocol Runner

**Run an explicit AI workflow, preserve what finished, and recover only the work that failed.**

Protocol Runner keeps a work plan, execution state, worker attempts and evidence outside
the coordinating conversation. It dispatches bounded assignments to Codex workers,
follows declared transitions and exposes the result through a local API and dashboard.
A contract defines what good work means; the runner records whether the prescribed
execution happened. Review and acceptance remain separate decisions.

This is the actual implementation extracted from a larger private development
repository. It includes the pure TypeScript core, persistent API, serial driver,
parallel executor, React dashboard, command-line tools and optional Windows Desktop
integration. It is not an official OpenAI project.

## Try the recovery demonstration

Use Node.js 22 (minimum 20.19) and pnpm 10.30.3. No Codex account is needed for this
demonstration.

```sh
pnpm install
pnpm build
pnpm demo
```

The demo uses the **real authenticated HTTP API, persistent store and executor**, with
the existing fake worker launcher. It completes `alpha`, injects a timeout for `beta`,
then requests a retry of `beta` alone. It asserts that:

- `alpha` keeps its original attempt and exactly the same output bytes;
- `beta` gets a new attempt, while its timed-out attempt remains inspectable;
- only one item launches on recovery, and the run then completes.

The failure is deliberately simulated. This exercises orchestration and recovery,
not model quality or live process termination. The script prints its evidence
directory under `.protocol-runner/demos/`, containing the plan, before/after
diagnostics, outputs and a machine-readable summary. It stops its services afterward.

Read the [example contract](examples/recovery/contract.md),
[work plan](examples/recovery/work_plan.json) and
[demo implementation](scripts/demo.mjs). The public [evidence record](docs/evidence.md)
separates release checks from historical use and remaining limits.

## Open the dashboard

```sh
pnpm start
```

Open [http://127.0.0.1:15174](http://127.0.0.1:15174). The default stack uses simulated
workers. Its API is at `http://127.0.0.1:14831`; the startup script prints the selected
addresses. Stop it with Ctrl+C. Local data remains in the ignored `.protocol-runner/`
directory, including a generated control token. Do not commit that directory.

The dashboard and CLI use the same API as the executor. They do not have an
independent copy of the transition logic.

## Run real workers deliberately

Real execution requires an installed, authenticated Codex CLI and uses its configured
model/account. Work consumes that account's usage. Select the directory whose
contracts, inputs and outputs the worker may access:

```sh
pnpm start -- --live --workspace /absolute/path/to/workspace
```

For the bundled example, deliberately select this repository as the workspace. The
live launcher uses `workspace-write`; the contract is still a work assignment, not a
hostile-process isolation boundary. Inspect [SECURITY.md](SECURITY.md) before changing
worker permissions or connecting other software. An accepted worker report does not
make its analysis correct.

Use the CLI's `usage` command to inspect operations before creating a run:

```sh
python scripts/tools/protocol_runner.py usage --format json
python scripts/tools/protocol_runner.py doctor --base-url http://127.0.0.1:14831 --format json
```

Always select the API explicitly when multiple stacks exist. A run belongs to one
backend; a missing run on another backend does not mean it was lost.

| Execution path | Purpose | Additional requirements |
| --- | --- | --- |
| Simulation | Reproduce API, execution-state and recovery behavior without a model | Node.js and pnpm |
| Parallel Codex workers | One fresh `codex exec` process for each leased assignment | Codex CLI, authentication, explicit workspace |
| Serial / mixed Desktop work | Preserve an existing conversation for dependent steps; combine it with independent workers | Optional Windows Desktop integration, prepared visible conversation and explicit binding |
| Source-writing workers | Isolated source contributions with declared ownership and Git handoff | Git, Python and the included source-workspace support; separate from artifact-only examples |

The Windows Desktop path is sensitive to application and visible UI state. The
portable API/executor path does not require Desktop or Discord. See the
[architecture](docs/architecture.md), [execution settings](docs/execution.md),
[Windows setup](docs/windows-desktop.md) and [source-workspace guide](docs/source-workspaces.md)
for the corresponding paths.

## Inspect the engineering

Start with [the design and failure history](docs/engineering.md). Then follow these
code paths:

| Question | Start here |
| --- | --- |
| Who determines the next step? | [Core transitions](packages/protocol-runner-core/src/transitions.ts) |
| Which operations are valid now? | [Core state machine](packages/protocol-runner-core/src/state-machine.ts) |
| What makes an item launchable or retryable? | [API controller](services/protocol-runner-api/src/controller.ts), [store](services/protocol-runner-api/src/store.ts) |
| What did a worker receive and return? | [Executor](services/protocol-runner-parallel-executor/src/executor.ts), [launcher](services/protocol-runner-parallel-executor/src/launcher.ts) |
| How do source edits survive an interrupted worker? | [Source workspaces](services/protocol-runner-parallel-executor/src/source-workspace.ts) |
| Where is the external control boundary? | [OpenAPI contract](contracts/protocol-runner.openapi.yaml), [server](services/protocol-runner-api/src/server.ts) |

`pnpm test` runs the extracted package tests; `pnpm lint` checks their source. These
checks and the deterministic demo have different purposes. Neither establishes that
an arbitrary agent task will produce a sound result.

## Origin and contribution

Created by **Justin Sublette** from sustained use of AI agents for repository
development and investigation. Justin originated the need and directed product
definition, architecture, consequential boundaries, integration, evaluation and
acceptance. Codex contributed extensively to implementation, testing, investigation
and operation. This repository does not imply unaided authorship of every line.

Private development history and operational data remain private. The public release
contains the runnable implementation and public examples; release qualification is
recorded against the public source. See [LICENSE](LICENSE) for reuse terms.
