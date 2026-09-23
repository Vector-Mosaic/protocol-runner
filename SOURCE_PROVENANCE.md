# Source provenance

Protocol Runner was developed by Justin Sublette with extensive implementation,
investigation and testing assistance from Codex in a private multi-system repository.
The standalone release starts from a fixed source snapshot selected on
September 23, 2026. Its exact private-source mapping is retained by the maintainer;
public commits identify the source available to readers here.

The core, API, serial driver, parallel executor and dashboard are the actual
implementation. The public layout shortens their paths and supplies standalone
dependency, launch and documentation entrypoints. Public-specific changes include
local API access protection, explicit live-worker launch settings, selective worker
environment inheritance and portable workspace selection. The optional Windows
Desktop integration includes its necessary source dependencies. The source-writing
workspace helper exposes the binding lifecycle it needs without the private
repository's integration/publishing machinery.

The public repository begins with a clean history. It does not include private Git
history, credentials, live research/work state, historical worker transcripts or
unrelated products. Historical results are described with their evidence limits in
the engineering documentation; they are not fresh qualification of this export.

Ordinary private development continues separately. Public releases are deliberate
exports with reviewed changes, not an automatic mirror. This provenance note is an
authorship and extraction account, not an independent verification certificate.

## Component map

| Component | Public location |
| --- | --- |
| Pure plan, prompt and transition logic | `packages/protocol-runner-core/` |
| Persistent API and state authority | `services/protocol-runner-api/` |
| Serial dispatch | `services/protocol-runner-driver/` |
| Parallel workers and source handoff | `services/protocol-runner-parallel-executor/` |
| Dashboard | `apps/protocol-runner-ui/` |
| Optional Windows Desktop and relay services | `services/codex-desktop-api/`, `services/codex-discord-desktop-relay/` |
| Desktop/relay dependencies | `packages/codex-remote-core/`, `packages/codex-thread-core/`, `packages/discord-transport/`, `ops/windows/` |
| Narrow source-workspace binding helper | `packages/concurrent_development/`, `scripts/tools/concurrent_development.py` |
| Control interfaces | `contracts/`, `scripts/tools/` |
| Standalone setup, public examples and evidence | Root configuration, `scripts/`, `examples/`, `docs/` |

## Maintaining the public release

Updates compare a new fixed private snapshot with the last exported snapshot, then
apply the relevant changes to the current public source. They do not copy an entire
private working directory over this repository. Public security defaults, standalone
configuration, examples, documentation and contributor changes remain part of the
merge. The narrow source-workspace helper is maintained as a public adaptation; it
must not silently regain private integration or publication operations.

Each release reviews new dependencies and exported contents, runs checks appropriate
to its changes, and records the observed result against its public commit. Live
Desktop, model and source-writing evidence retain their own qualification scopes.
Generated runtime data and credentials remain outside source control. Upstreaming a
public improvement into private development is a separate deliberate merge, not an
automatic synchronization process.
