import {
  GENERIC_STEP_PROMPT_TEMPLATE_ID,
  isResolvedSerialStep,
  type PromptTemplateId,
  type ResolvedStep,
} from './types.js'

export interface RenderPromptInput {
  run_instance_id: string
  step: ResolvedStep
  prompt_attempt_id: string
  start_token: string
  report_commands?: SerialReportCommands
}

/** Installed helper argv supplied by the host; never include control credentials. */
export interface SerialReportCommands {
  shell: 'powershell' | 'posix'
  start_report: readonly string[]
  status_report: readonly string[]
}

function quoteArgument(value: string, shell: SerialReportCommands['shell']): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Report command arguments cannot contain line breaks or NUL.')
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value
  return shell === 'powershell'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\"'\"'")}'`
}

function renderReportCommand(argv: readonly string[], shell: SerialReportCommands['shell']): string {
  if (argv.length === 0 || argv[0].length === 0) throw new Error('Report commands require an executable.')
  return `${shell === 'powershell' ? '& ' : ''}${argv.map((arg) => quoteArgument(arg, shell)).join(' ')}`
}

export function renderGenericStepPrompt(input: RenderPromptInput): string {
  const { run_instance_id: runInstanceId, step, prompt_attempt_id: promptAttemptId, start_token: startToken } = input
  if (!isResolvedSerialStep(step)) {
    throw new Error('parallel_group steps do not use the generic serial prompt template.')
  }

  const visibleWorkItemJson = JSON.stringify(step.visible_work_item, null, 2)
  const commands = input.report_commands ?? {
    shell: 'posix' as const,
    start_report: ['python', 'scripts/tools/protocol_runner_step_start.py'],
    status_report: ['python', 'scripts/tools/protocol_runner_return.py'],
  }
  const startCommand = renderReportCommand([
    ...commands.start_report,
    '--run-instance-id', runInstanceId, '--step-id', step.step_id,
    '--prompt-attempt-id', promptAttemptId, '--start-token', startToken,
  ], commands.shell)
  const statusCommand = renderReportCommand([
    ...commands.status_report,
    '--run-instance-id', runInstanceId, '--step-id', step.step_id, '--status', 'completed',
  ], commands.shell)

  return `# Protocol Runner Step Start Report

Before reading the framework/contract or doing any contract work, make exactly one local Protocol Runner start-report call:

${startCommand}

This start-report call confirms that this exact prompt reached the worker thread and that you are beginning this exact planned step. If this start-report call fails, stop before doing contract work and report the command error visibly. Do not retry, skip, batch, or continue to the contract work unless the start-report call succeeds.

# Protocol Runner Invocation

This is a protocol-runner invocation for one bounded planned step.

Run instance: ${runInstanceId}
Step: ${step.step_id}
Step kind: ${step.step_kind}
Prompt attempt: ${promptAttemptId}
Progress: ${step.ordinal} of ${step.total_steps}

We are executing ${step.contract.title} for this planned step only. The authoritative framework/contract is defined at:

${step.contract.path}

Read ${step.contract.path} in full before starting work. Do not treat this invocation prompt as a substitute for, summary of, or modification to that framework/contract.

The work for this invocation is to apply the referenced framework/contract to this planned step only:

Planned step:
${step.planned_step}

Codex-visible work item:
${visibleWorkItemJson}

Follow the grounding rules and grounding sequence defined in ${step.contract.path}. Ground on the files/information it identifies, in the order and timing it requires. Ground according to the contract before starting work, and continue following its grounding instructions during the work process.

Instructions for output shape, output location, completion requirements, and any required reporting are defined in ${step.contract.path}.

Do only this planned step.
Do not continue to later steps.
Do not inspect or infer the hidden ordered work plan.
Do not batch, script, compress, or generalize across multiple planned steps.

When this planned step is complete or blocked, before ending your turn make exactly one local Protocol Runner status-report call:

${statusCommand} --summary "<one-line procedural summary>"

Use --status blocked only if you cannot complete this planned step under the referenced contract.

This local status-report call is the runner handoff. Do not ask the runner to read your visible response. Do not put runner handoff data in your visible response. If the local status-report call fails, report the command error visibly and do not claim the runner was updated.`
}

export function renderPrompt(templateId: PromptTemplateId, input: RenderPromptInput): string {
  if (templateId === GENERIC_STEP_PROMPT_TEMPLATE_ID) {
    return renderGenericStepPrompt(input)
  }

  throw new Error(`Unsupported prompt template: ${templateId}`)
}
