# Security and trust boundary

Protocol Runner is a local, single-operator application. Run it on a machine and
workspace you control. Do not expose its API, dashboard, Desktop service or relay
through a public tunnel or reverse proxy.

The supplied launcher binds services to loopback. It generates an ignored local
control token; the Runner API requires that token for control and evidence access
and checks the exact local Host/Origin. The dashboard's local proxy supplies the
token server-side. Browser bundles and prompts do not contain it. Minimal health
responses are intentionally public to local callers. This prevents unauthenticated
control requests; it does not isolate other OS users or agents that can read the
token file. Protect local files with your operating system's account permissions.

`pnpm start` and `pnpm demo` use simulated workers. Real Codex execution requires an
explicit live command and workspace. The launcher requests `workspace-write`, uses
one worker by default and never retries with unrestricted access after a sandbox
failure. Worker processes receive a selected environment instead of all service
credentials. Your Codex configuration and connected tools still determine additional
capabilities; review those before running untrusted assignments. See
[execution](docs/execution.md) for launch and cancellation details.

Plans, contracts, worker packets and output paths establish procedural scope.
They are not a hostile-process isolation boundary. In artifact-only mode, workers
share the selected workspace. A worker completion report does not certify the
truth, quality or safety of its output. Keep substantive review separate.

The optional Windows Desktop integration controls an existing visible application
and preserves that thread's current permissions. Its Discord credentials and
channel access are separate control boundaries. Follow the
[Windows integration guide](docs/windows-desktop.md).

Local state can contain prompts, input material, process output and absolute paths.
It stays under ignored `.protocol-runner/` directories; contract-owned outputs may
have other declared locations. Do not commit local credentials, `.env` files or raw
run traces. Inspect and redact example evidence before sharing it. Ordinary closeout
preserves declared work outputs; explicit output deletion is a separate action.

If reporting a defect, provide a minimal reproduction with public fixtures. Never
put tokens, private contracts or live transcripts in an issue. For a sensitive
vulnerability, use the repository's private vulnerability reporting option when
available rather than a public issue.
