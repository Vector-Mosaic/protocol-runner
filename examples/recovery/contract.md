# Recovery demonstration contract

This example exercises execution and recovery. Its two item inputs are deliberately
small so that the control behavior is easy to inspect.

For a real worker, read only the assigned input and produce a concise Markdown
review at the assigned sealed output path. Identify the claim, whether the supplied
observation supports it, and one limitation. Do not inspect sibling inputs or
outputs, change source files, or decide whether the overall run is accepted.
Report `completed` only after writing that output; otherwise report `blocked`
with the missing prerequisite. Follow the invocation's status-report instructions.

The credential-free `pnpm demo` does not ask a model to perform this review. It
uses the existing fake worker launcher to write explicitly labeled fixture output
and inject one timeout. That demonstrates the real API, executor, store and retry
behavior without making a claim about model reasoning or process termination.
