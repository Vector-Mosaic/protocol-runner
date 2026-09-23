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

Release preparation is in progress. No fresh build, package-test, lint or runtime
pass is claimed in this document yet. Replace this paragraph with the actual public
source identity, execution environment, selected commands and observed results when
qualification finishes. Failures and unexercised optional profiles must remain visible.

Existing source includes focused regression coverage for transition validation,
preflight and item retry, stale leases, process outcomes, store lifecycle and UI
controls. A test's presence is evidence of an authored check, not evidence that the
current extraction passed it. The workspace `pnpm test` command runs those checks.

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
- Optional Windows Desktop behavior depends on visible application state and needs
  qualification on the selected workstation/application version.
- Source-writer lifecycle support has separate Git, Python, ownership and handoff
  requirements; the artifact-only recovery example does not exercise it.
- No controlled comparison establishes better quality, speed or cost than another
  orchestration approach. Long-duration soak and concurrency above fifty are not
  established by the historical result.
