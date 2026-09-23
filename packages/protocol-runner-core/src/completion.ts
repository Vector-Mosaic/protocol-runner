import {
  type CompletionStatus,
  type StepStartReport,
  type StatusReport,
  type ValidationIssue,
  type ValidationResult,
} from './types.js'

export interface StatusReportParseResult extends ValidationResult {
  status_report?: StatusReport
}

export interface StepStartReportParseResult extends ValidationResult {
  start_report?: StepStartReport
}

const ALLOWED_KEYS = new Set(['run_instance_id', 'step_id', 'status', 'summary'])
const START_ALLOWED_KEYS = new Set(['run_instance_id', 'step_id', 'prompt_attempt_id', 'start_token'])
const COMPLETION_STATUSES = new Set<CompletionStatus>(['completed', 'blocked'])
type RequiredStatusReportKey = 'run_instance_id' | 'step_id' | 'status'
type RequiredStartReportKey = 'run_instance_id' | 'step_id' | 'prompt_attempt_id' | 'start_token'

function pushIssue(
  issues: ValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({
    code,
    message,
    path,
    severity: 'error',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredStringField(
  input: Record<string, unknown>,
  key: RequiredStatusReportKey,
  issues: ValidationIssue[],
): string | undefined {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(issues, 'status_report_key.required', `$.${key}`, `${key} is required.`)
    return undefined
  }

  return value.trim()
}

function requiredStartStringField(
  input: Record<string, unknown>,
  key: RequiredStartReportKey,
  issues: ValidationIssue[],
): string | undefined {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(issues, 'start_report_key.required', `$.${key}`, `${key} is required.`)
    return undefined
  }

  return value.trim()
}

export function parseProtocolRunnerStepStartReport(input: unknown): StepStartReportParseResult {
  const issues: ValidationIssue[] = []

  if (!isRecord(input)) {
    pushIssue(issues, 'start_report.not_object', '$', 'Start report must be an object.')
    return { ok: false, issues }
  }

  for (const key of Object.keys(input)) {
    if (!START_ALLOWED_KEYS.has(key)) {
      pushIssue(issues, 'start_report_key.unexpected', `$.${key}`, `Unexpected start report key: ${key}.`)
    }
  }

  const run_instance_id = requiredStartStringField(input, 'run_instance_id', issues)
  const step_id = requiredStartStringField(input, 'step_id', issues)
  const prompt_attempt_id = requiredStartStringField(input, 'prompt_attempt_id', issues)
  const start_token = requiredStartStringField(input, 'start_token', issues)

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return {
    ok: true,
    issues,
    start_report: {
      run_instance_id: run_instance_id ?? '',
      step_id: step_id ?? '',
      prompt_attempt_id: prompt_attempt_id ?? '',
      start_token: start_token ?? '',
    },
  }
}

export function parseProtocolRunnerStatusReport(input: unknown): StatusReportParseResult {
  const issues: ValidationIssue[] = []

  if (!isRecord(input)) {
    pushIssue(issues, 'status_report.not_object', '$', 'Status report must be an object.')
    return { ok: false, issues }
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      pushIssue(issues, 'status_report_key.unexpected', `$.${key}`, `Unexpected status report key: ${key}.`)
    }
  }

  const run_instance_id = requiredStringField(input, 'run_instance_id', issues)
  const step_id = requiredStringField(input, 'step_id', issues)
  const rawStatus = requiredStringField(input, 'status', issues)
  if (rawStatus !== undefined && !COMPLETION_STATUSES.has(rawStatus as CompletionStatus)) {
    pushIssue(issues, 'status_report_status.invalid', '$.status', 'status must be completed or blocked.')
  }

  let summary: string | undefined
  if ('summary' in input) {
    if (input.summary !== undefined && typeof input.summary !== 'string') {
      pushIssue(issues, 'status_report_key.invalid', '$.summary', 'summary must be a string when provided.')
    } else {
      summary = input.summary?.trim()
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return {
    ok: true,
    issues,
    status_report: {
      run_instance_id: run_instance_id ?? '',
      step_id: step_id ?? '',
      status: rawStatus as CompletionStatus,
      ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
    },
  }
}

export function validateStatusReportForStep(
  statusReport: StatusReport,
  expected: { run_instance_id: string; step_id: string },
): ValidationResult {
  const issues: ValidationIssue[] = []

  if (statusReport.run_instance_id !== expected.run_instance_id) {
    pushIssue(
      issues,
      'status_report.run_instance_id_mismatch',
      '$.run_instance_id',
      `Status report run_instance_id ${statusReport.run_instance_id} does not match ${expected.run_instance_id}.`,
    )
  }

  if (statusReport.step_id !== expected.step_id) {
    pushIssue(
      issues,
      'status_report.step_id_mismatch',
      '$.step_id',
      `Status report step_id ${statusReport.step_id} does not match ${expected.step_id}.`,
    )
  }

  return { ok: issues.length === 0, issues }
}

export function validateStepStartReport(
  startReport: StepStartReport,
  expected: {
    run_instance_id: string
    step_id: string
    prompt_attempt_id: string
    start_token: string
  },
): ValidationResult {
  const issues: ValidationIssue[] = []

  if (startReport.run_instance_id !== expected.run_instance_id) {
    pushIssue(
      issues,
      'start_report.run_instance_id_mismatch',
      '$.run_instance_id',
      `Start report run_instance_id ${startReport.run_instance_id} does not match ${expected.run_instance_id}.`,
    )
  }

  if (startReport.step_id !== expected.step_id) {
    pushIssue(
      issues,
      'start_report.step_id_mismatch',
      '$.step_id',
      `Start report step_id ${startReport.step_id} does not match ${expected.step_id}.`,
    )
  }

  if (startReport.prompt_attempt_id !== expected.prompt_attempt_id) {
    pushIssue(
      issues,
      'start_report.prompt_attempt_id_mismatch',
      '$.prompt_attempt_id',
      `Start report prompt_attempt_id ${startReport.prompt_attempt_id} does not match ${expected.prompt_attempt_id}.`,
    )
  }

  if (startReport.start_token !== expected.start_token) {
    pushIssue(issues, 'start_report.start_token_mismatch', '$.start_token', 'Start report token does not match.')
  }

  return { ok: issues.length === 0, issues }
}
