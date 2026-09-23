# Recover one item without restarting its completed sibling

Run `pnpm demo` from the repository root. The startup script creates an isolated
local API and passes its credential to `scripts/demo.mjs`; the demo stops the stack
after collecting evidence.

The script copies `work_plan.json` into a unique local demo directory and assigns a
fresh output base. The original plan's `executor: "codex_exec"` identifies the runner's
parallel lane; the demo deliberately supplies that lane's fake launcher. No model is
contacted and neither review input is answered by AI during the demonstration.

1. Create and bind a parallel-only run through the API.
2. Preflight the current group; obtain two real leases through the executor.
3. Complete `alpha` and inject a `timed_out` result for `beta`.
4. Record diagnostics and hash `alpha`'s completed output.
5. Retry `beta` explicitly through the API. Check that only one item is launchable.
6. Complete the new attempt. Check the retained timeout, distinct attempt identity,
   completed run and unchanged `alpha` output.

The example leaves its evidence for inspection and prints `summary.json`'s location.
It does not delete unrelated state or launch work for any other run.

The contract and inputs can also seed a small real-worker exercise. In that case the
worker actually answers its assigned review question. Do not present the deterministic
demo's fixture output as a real review or infer substantive acceptance from the
runner's completion status.
