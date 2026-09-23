# Source provenance

Protocol Runner was developed by Justin Sublette with extensive implementation,
investigation and testing assistance from Codex in a private multi-system repository.
This standalone release starts from source revision
`295fd1ce7bc4ba10953abe07379357514ff353b8`, selected on September 23, 2026.

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
