# Working in Protocol Runner

Read `README.md`, then `docs/architecture.md` and the component you are changing.
Use `docs/evidence.md` for the scope of existing qualification, not as a claim that
an unrelated change has passed.

- `packages/protocol-runner-core` owns pure schema, prompt and transition logic.
- `services/protocol-runner-api` owns persistent state, leases and accepted results.
- `services/protocol-runner-driver` drives serial work through the API.
- `services/protocol-runner-parallel-executor` launches one process per lease.
- `apps/protocol-runner-ui` observes and controls through the API.
- `scripts/demo.mjs` uses simulated workers against the actual HTTP boundary.
- `contracts/protocol-runner.openapi.yaml` describes that boundary.

Keep the API as the state authority. Preserve failed attempts and completed sibling
outputs when changing retry behavior. Never infer semantic acceptance from a worker
report. Keep contracts and item inputs scoped to the assigned work.

Default to simulated workers for development. Live workers require deliberate
workspace/account selection. Follow `SECURITY.md`; never commit credentials,
`.protocol-runner/`, worker transcripts or machine-specific configuration.

Run the affected component checks and the recovery demo when its behavior changes.
Do not run every suite after a documentation-only edit. Preserve unrelated edits.
Report what was checked and any remaining limitation plainly.
