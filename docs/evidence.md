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

### Live Windows execution: output verified, full completion still unqualified

The same runtime source was exercised on Windows 11 with Node.js 20.19.0, the
operator's configured `gpt-6-astra` model, one worker and `workspace-write`, without
sandbox bypass. The input was deliberately rote: read the assigned literal and
write `PARALLEL_SMOKE_OUTPUT: smoke_item_001: blueberries` plus a status report.
It is an execution check, not a reasoning benchmark.

1. The globally installed Codex CLI 0.144.1 rejected the configured model as requiring
   a newer CLI. Runner recorded a failed attempt without fabricating output.
2. The already-installed CLI 0.155.0-alpha.16 launched the worker. Private global
   onboarding instructions consumed its 120-second bound. Runner terminated the
   process, recorded `timed_out`, and retained the attempt.
3. An explicit API retry created a second attempt in that run, with an installed
   Python path and a 300-second bound. The worker produced the exact expected output
   and a valid status report. It reported `blocked` because the sandbox denied the
   Python command required by those unrelated global instructions. The API retained
   both the timed-out attempt and the new blocked result.

The output's SHA-256 was
`caa57a5af3dc1d31535b0d420cabc16ed7e38e81024a4ae770223021823cd4a5`.
This establishes a real model launch, file output, structured return, bounded
termination and retry history on that machine. It does **not** establish a completed
live workflow or a successful explicit API-stop smoke. Live execution remains
experimental pending that qualification with a suitable operator configuration.
The configuration and sandbox were not broadened to turn the result into a pass.
Raw local traces remain private because they contain machine-specific instructions.

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
- A fully completed live workflow and explicit live API-stop scenario remain
  unqualified; the Windows observations above establish narrower behavior.
- Optional Windows Desktop behavior depends on visible application state and needs
  qualification on the selected workstation/application version.
- Source-writer lifecycle support has separate Git, Python, ownership and handoff
  requirements; the artifact-only recovery example does not exercise it.
- No controlled comparison establishes better quality, speed or cost than another
  orchestration approach. Long-duration soak and concurrency above fifty are not
  established by the historical result.
