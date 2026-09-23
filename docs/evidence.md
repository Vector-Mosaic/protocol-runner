# Evidence and qualification

Keep three categories separate: inspectable implementation, checks executed against
the public source, and historical observations from the original development system.

## Reproduce the public recovery behavior

```sh
pnpm install
pnpm build
pnpm demo
```

The demo calls the authenticated HTTP API and runs the production executor with its
existing fake launcher. It records the plan, interrupted state, recovered state and
summary under `.protocol-runner/demos/<run-id>/`. A successful summary requires all
of the following assertions to hold:

| Assertion | Observation |
| --- | --- |
| Completed work survives | `alpha` has the same attempt ID and output SHA-256 before and after retry |
| Retry is item-scoped | Recovery preflight exposes one launchable item; one item launches |
| Failed history survives | `beta`'s timed-out attempt remains in diagnostics |
| Retry has a distinct identity | `beta` completes under a new attempt ID |
| The declared procedure finishes | The API reports the run completed after both items complete |

This is deterministic failure injection, not a real Codex failure or a demonstration
of killing a live process. It does not evaluate the contents of an AI-generated review.
The output labels its simulated nature. Local evidence may contain absolute paths;
inspect and sanitize it before sharing.

## Current public-release qualification

The September 23, 2026 qualification used public source
[`ca684dd8`](https://github.com/Vector-Mosaic/protocol-runner/commit/ca684dd8d43d17786e087d1f1bcb27e25dc85b46).
The [recorded run](https://github.com/Vector-Mosaic/protocol-runner/actions/runs/35825094675)
passed on GitHub's Ubuntu runner with Node.js 22, Python 3.12 and pnpm 10.30.3.
Later release-preparation edits document these results and remove the temporary
compiled-file transfer; they do not change the qualified runtime implementation.

| Check | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile` and `pnpm build` | All standalone packages and the dashboard built |
| `pnpm test` | 303 Node tests and 14 dashboard tests passed |
| `python -B -m unittest packages.concurrent_development.test_core` | Five source-workspace lifecycle tests passed |
| `pnpm lint` | Passed for all components |
| `pnpm demo` | Completed sibling preserved byte-for-byte, failed attempt retained, only beta retried, final run completed |
| `node scripts/startup-check.mjs` | Dashboard/proxy served; direct unauthenticated API, cross-site and wrong-Host requests refused; SIGINT exited cleanly and all four service ports closed |

The tests include transition validation, item retry, stale leases, process outcomes,
source handoff, store recovery and UI controls. Their assertions have those specific
scopes. The manual workflow uploads no artifacts and does not run automatically on
every push. The temporary compiled JavaScript used for the Windows check was removed
from GitHub after download.

### Live Windows execution: completion and explicit stop passed

The same runtime implementation, at release candidate `2d1d52e`, passed both small
live checks on September 23, 2026. The environment was Windows 11, Node.js 20.19.0,
Codex CLI 0.155.0-alpha.16, `gpt-6-astra` with `ultra` reasoning, and one worker at
a time. Both checks used `workspace-write`, approval policy `never`, no sandbox
bypass and a 120-second worker limit.

The worker used a dedicated `CODEX_HOME` authenticated through the normal login
flow, with credentials in the OS credential store. This excluded the operator's
unrelated private global onboarding instructions while retaining public project
instructions. The operator's ordinary Codex configuration was unchanged. See the
[reproduction procedure](execution.md#codex-home-and-reproducible-qualification).

| Live check | Observed result |
| --- | --- |
| `smoke_ladder.js --live --rung real_1` | Worker exited successfully, wrote the expected output and completed its status report; the API reported one completed item, one completed attempt, and a completed group and run |
| `process_control_smoke.js --live --scenario stop` | After the worker wrote its readiness marker, an explicit API stop cancelled its attempt and lease, stopped the group and terminated the worker process; cancellation evidence was retained |

The completion input was deliberately rote: read the assigned literal and write
`PARALLEL_SMOKE_OUTPUT: smoke_item_001: blueberries` plus a status report. The
output file's SHA-256 was
`41681fe75b8a122c1cb3ff8f202eac28a702bcc191b393cb69734aa71a4dd070`.
The stop scenario correctly left its run blocked and its group stopped; it was
not counted as completed work. Both smoke summaries reported `passed: true` and
both harness processes exited successfully. These are execution and cancellation
checks, not a reasoning benchmark or a multi-worker scalability result.

Earlier attempts exposed two setup issues: CLI 0.144.1 did not support the selected
model, and the operator's ordinary Codex home injected private onboarding that
caused a timeout and then a blocked retry despite correct output. Those retained
failures were resolved for these checks by selecting the installed compatible CLI
and a dedicated Codex home, without changing Runner's runtime implementation or
broadening its sandbox. Raw traces remain local because they can contain private
instructions and machine-specific information.

## Historical evidence

The [engineering account](engineering.md) summarizes a retained real campaign and
specific failures that shaped the system. The private development system has also
been used for serial, parallel and mixed work, including a bounded fifty-worker
exercise on simple assignments. That result was host-specific and saturated its CPU.
It is not a recommended public concurrency setting, a scalability benchmark, or
qualification of this extracted release on a new machine.

Historical private evidence is not included as an opaque archive readers must trust.
The public value is source that can be inspected and behavior that can be reproduced.
Historical observations retain their original limits and do not substitute for the
current release's checks.

## Remaining limits

- A worker's `completed` report and a present output establish procedural facts;
  semantic review remains separate.
- The credential-free demo injects a timeout without launching or interrupting Codex.
- The live completion and explicit stop results cover one worker on the Windows
  environment above; other platforms and concurrent live workers need their own
  relevant qualification.
- Optional Windows Desktop behavior depends on visible application state and needs
  qualification on the selected workstation/application version.
- Source-writer lifecycle support has separate Git, Python, ownership and handoff
  requirements; the artifact-only recovery example does not exercise it.
- No controlled comparison establishes better quality, speed or cost than another
  orchestration approach. Long-duration soak and concurrency above fifty are not
  established by the historical result.
