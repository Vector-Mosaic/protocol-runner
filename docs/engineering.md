# Why this system exists

Protocol Runner grew out of a practical problem: a capable agent could perform useful
work inside one conversation while the larger procedure remained fragile. Plans
could lose detail through handoffs, a plausible partial result could be reported as
complete, and independent workers could finish without a coherent integration path.
The design puts the procedure somewhere inspectable and durable.

Justin Sublette originated that problem and directed the system's design, integration,
evaluation and acceptance. Codex supplied extensive implementation, testing,
investigation and operating work. The technical contribution is the combined system
and the decisions behind it; no claim of unaided authorship is made.

## Decisions shaped by failures

### A delivered message is not a started assignment

Early desktop integration showed that a request could persist in shared conversation
state without appearing in the intended visible conversation. Delivery, visible
effect and worker receipt were different observations. The runner therefore records
an explicit binding and matches a start report to the current prompt attempt. It
does not infer receipt from the existence of a message alone.

The serial path still depends on UI state. Stronger receipt evidence makes its claim
more precise; it does not make every application version, display or focus transition
reliable. Start with the [API controller](../services/protocol-runner-api/src/controller.ts)
and [serial driver](../services/protocol-runner-driver/src/driver.ts).

### Keeping the procedure matters as well as getting an answer

A worker can produce an orderly artifact while replacing the requested independent
investigation with a bulk transformation. A workflow can also skip review or start
integration early while still looking productive. Runner makes the chosen topology
explicit: bounded assignments, declared steps and transitions selected by external
state. Workers reason within their assignments; they do not silently replace the
outer workflow.

This is why [transition resolution](../packages/protocol-runner-core/src/transitions.ts)
checks the current step before applying the plan's completion rule. It is also a
deliberate limit: a poor plan can be followed faithfully. The runner cannot make that
plan wise, nor establish that a worker complied with every substantive instruction.

### Retrying should conserve useful work

A group-level failure should not erase a successful sibling's output. The data model
separates an assignment from its attempts, and explicit retry creates a new identity
for only the affected assignment. Preflight checks its output target again instead of
overwriting an unexpected file. The old failure remains available for diagnosis.

The public [recovery demo](../scripts/demo.mjs) makes this property inspectable through
the real API and executor. It checks attempt identities, retained failure state and
the completed output's SHA-256 before and after recovery. Its workers are simulated;
the test of preservation is real.

### The working directory is part of execution identity

A historical assignment launched from the shared checkout even though its contract
named an isolated checkout. The expected output was missing. An artifact found
elsewhere was not accepted as proof that the intended assignment had succeeded.
The executor's workspace binding was corrected and the assignment rerun. Its resulting
analysis still reported unresolved issues; fixing execution did not turn the answer
into an approval.

The current implementation carries an explicit workspace and separates artifact-only
work from isolated source-writing work. Review
[source-workspace.ts](../services/protocol-runner-parallel-executor/src/source-workspace.ts)
for ownership, handoff and process-lifetime boundaries.

## Actual use and the claims it supports

In one retained development-history campaign, a fixed interval of 595 commits was
screened into twelve packets and examined through 25 bounded investigation assignments.
The integrated draft contained 40 accounts and 190 claims. A separate review identified
three substantive narrative defects. Those accounts were corrected while the other
37 and the completed investigations were retained; a fresh reviewer then examined
the complete corrected draft.

This is a summarized historical use case from the private development record, not
a benchmark executed by this public release. Its raw private inputs and transcripts
are not published here. It illustrates the division of responsibility: Runner
coordinated execution, investigators and reviewers supplied judgment, and a separate
record owner accepted the resulting history. Editorial recovery across that campaign
is also distinct from the mechanical API retry demonstrated in this repository.

## What would change the assessment

The useful next evidence is a bounded live demonstration: publish its plan first,
show real assignments, interrupt one worker, preserve completed outputs, recover the
affected item, and independently review the substantive result. A performance or
quality advantage would require an actual comparison with a specified alternative,
task set, costs and evaluation method.

The present claim is narrower: this implementation preserves declared execution
structure and exposes attempts, evidence and recovery. It does not establish model
improvement, universal task correctness, production-scale reliability or superiority
over another orchestrator. See [evidence.md](evidence.md) for the public release's
observed checks and remaining qualification.
