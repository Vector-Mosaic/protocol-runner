import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import initSqlJs from 'sql.js'

import {
  RUN_STATE_SCHEMA_VERSION,
  type ParallelGroupItem,
  type ParallelGroupStep,
  type ResolvedStep,
  type ResolvedParallelGroupStep,
  type RunAutomationSettings,
  type RunnerEvent,
  type RunnerEventType,
  type RunState,
  type StepStartReport,
  type StatusReport,
  type WorkerCapability,
  WORKER_CAPABILITIES,
  type WorkPlan,
  resolveStepByOrdinal,
  validateWorkPlan,
} from '../../../packages/protocol-runner-core/dist/index.js'
import {
  RunArtifactLifecycle,
  RunLifecycleCoordinator,
  type RunArtifactReconciliationReport,
} from './run-artifact-lifecycle.js'

export const DEFAULT_PROTOCOL_RUNNER_RUNS_ROOT = path.join('artifacts', 'protocol_runner', 'runs')
export const DEFAULT_PROTOCOL_RUNNER_SQLITE_DB_PATH = path.join('artifacts', 'protocol_runner', 'protocol_runner.sqlite')
export const DEFAULT_PARALLEL_LEASE_TTL_MS = 5 * 60 * 1000

export const RUN_INSTANCE_ID_PATTERN = /^[a-z0-9_-]+$/
const PARALLEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const SQLITE_SCHEMA_VERSION = '2'
const RUN_DESCENDANT_TABLES = [
  'parallel_leases',
  'parallel_attempts',
  'parallel_items',
  'parallel_groups',
  'evidence_files',
  'runner_events',
  'run_steps',
] as const

export type StoreEvidenceKind = 'step' | 'prompt' | 'start' | 'status' | 'parallel_preflight'

export type ParallelGroupStatus =
  | 'pending'
  | 'preflighting'
  | 'ready_to_lease'
  | 'leasing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'needs_attention'
  | 'stopped'
  | 'cancelled'

export type ParallelItemStatus =
  | 'pending'
  | 'leased'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'needs_recovery'
  | 'cancelled'
  | 'stopped'

export type ParallelAttemptStatus =
  | 'created'
  | 'leased'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'timed_out'
  | 'evidence_missing'
  | 'output_missing'
  | 'status_invalid'

export type ParallelLeaseStatus = 'active' | 'released' | 'expired' | 'cancelled'
export type ParallelPreflightStatus = 'not_run' | 'passed' | 'failed'
export type ParallelPreflightCheckStatus = 'passed' | 'failed' | 'warning'
export type ParallelAttemptWarningCode = 'long_running' | 'possibly_stalled'
export type ParallelAttemptResultStatus =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'evidence_missing'
  | 'output_missing'
  | 'status_invalid'

export interface ParallelPreflightCheck {
  code: string
  status: ParallelPreflightCheckStatus
  message: string
  path?: string
  details?: Record<string, unknown>
}

export interface ParallelPreflightResult {
  run_instance_id: string
  step_id: string
  group_id: string
  passed: boolean
  preflight_status: ParallelPreflightStatus
  checked_at: string
  checked_by: string
  checks: ParallelPreflightCheck[]
  errors: ParallelPreflightCheck[]
  warnings: ParallelPreflightCheck[]
  executor_summary: Record<string, unknown>
  max_concurrency: number
  item_count: number
  launchable_item_count: number
  evidence_file?: StoreFileRef
}

export interface ParallelAttemptWarning {
  code: ParallelAttemptWarningCode
  severity: 'warning'
  message: string
  observed_at: string
  threshold_ms: number
  elapsed_ms: number
  quiet_ms?: number
  last_observed_evidence_at?: string
  details?: Record<string, unknown>
}

export interface ParallelItemState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  label?: string
  status: ParallelItemStatus
  input_ref: string
  contract_ref: string
  sealed_output_target: string
  latest_attempt_id: string | null
}

export interface ParallelAttemptState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  attempt_number: number
  status: ParallelAttemptStatus
  evidence_dir: string | null
  latest_lease_id: string | null
  warnings: ParallelAttemptWarning[]
  created_at: string
  updated_at: string
}

export interface ParallelLeaseState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  lease_id: string
  executor_id: string
  status: ParallelLeaseStatus
  leased_at: string
  expires_at: string | null
  heartbeat_at: string | null
  created_at: string
  updated_at: string
}

export interface ParallelLeasePacket extends ParallelLeaseState {
  run_dir: string
  attempt_dir: string
  prompt_path: string
  worker_packet_path: string
  status_report_path: string
  process_path: string
  result_path: string
  sealed_output_path: string
  input_ref: string
  contract_ref: string
  variables: Record<string, unknown>
  required_worker_capabilities: WorkerCapability[]
  source_writer?: {
    base_commit: string
    owned_paths: string[]
    artifact_root: string
  }
}

export interface ParallelGroupState {
  run_instance_id: string
  step_id: string
  group_id: string
  ordinal: number
  status: ParallelGroupStatus
  executor: ParallelGroupStep['executor']
  contract_ref: string
  max_concurrency: number
  required_worker_capabilities: WorkerCapability[]
  preflight_status: ParallelPreflightStatus
  checked_at: string | null
  checked_by: string | null
  preflight_errors: ParallelPreflightCheck[]
  preflight_warnings: ParallelPreflightCheck[]
  preflight_result: ParallelPreflightResult | null
  items: ParallelItemState[]
  attempts: ParallelAttemptState[]
  leases: ParallelLeaseState[]
}

export interface RecordParallelPreflightInput {
  step: ResolvedParallelGroupStep
  result: ParallelPreflightResult
}

export interface GrantParallelLeasesInput {
  executor_id: string
  capacity: number
  lease_ttl_ms?: number
}

export interface ParallelLeaseGrantResult {
  group: ParallelGroupState
  leases: ParallelLeasePacket[]
}

export interface RecordParallelHeartbeatInput {
  heartbeat_at?: string
  attempt_warnings?: ParallelAttemptWarning[]
}

export interface RecordParallelAttemptResultInput {
  lease_id: string
  attempt_id: string
  status: ParallelAttemptResultStatus
  status_report?: Record<string, unknown>
  process?: Record<string, unknown>
  status_report_path?: string
  sealed_output_path?: string
  result_path?: string
  summary?: string
}

export interface ParallelAttemptResultRecord {
  group: ParallelGroupState
  attempt: ParallelAttemptState
  lease: ParallelLeaseState | null
}

export interface RetryParallelItemInput {
  requested_by?: string
  reason?: string
}

export interface RetryParallelItemResult {
  group: ParallelGroupState
  attempt: ParallelAttemptState
  previous_attempt_id: string | null
}

export type ParallelGroupControlAction = 'pause' | 'stop'

export interface ControlParallelGroupInput {
  reason?: string
}

export interface RecoverStaleParallelLeasesInput {
  observed_at?: string
}

export interface RecoverStaleParallelLeasesResult {
  group: ParallelGroupState
  observed_at: string
  stale_lease_ids: string[]
  stale_attempt_ids: string[]
  stale_item_ids: string[]
  requeued_lease_ids: string[]
  requeued_attempt_ids: string[]
  requeued_item_ids: string[]
  attention_lease_ids: string[]
  attention_attempt_ids: string[]
  attention_item_ids: string[]
}

export interface JsonRunnerStoreOptions {
  runs_root?: string
  now?: () => Date
  event_id_factory?: () => string
  artifact_lifecycle?: RunArtifactLifecycle
}

export interface SqliteRunnerStoreOptions extends JsonRunnerStoreOptions {
  db_path?: string
}

export interface HybridRunnerStoreOptions {
  primary: SqliteRunnerStore
  legacy_json: JsonRunnerStore
}

type SqliteValue = number | string | Uint8Array | null
type SqliteDatabase = initSqlJs.Database

export interface CreateRunInput {
  run_instance_id: string
  work_plan: WorkPlan
  automation?: Partial<RunAutomationSettings>
}

export interface StoredRun {
  run_instance_id: string
  run_dir: string
  work_plan: WorkPlan
  state: RunState
}

export interface RunListItem {
  run_instance_id: string
  status: RunState['status']
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: RunAutomationSettings
  updated_at: string
}

export interface RunPaths {
  run_dir: string
  work_plan_path: string
  state_path: string
  events_path: string
  steps_dir: string
  prompts_dir: string
  starts_dir: string
  status_dir: string
}

function runPathsForDir(run_dir: string): RunPaths {
  return {
    run_dir,
    work_plan_path: path.join(run_dir, 'work_plan.json'),
    state_path: path.join(run_dir, 'state.json'),
    events_path: path.join(run_dir, 'events.jsonl'),
    steps_dir: path.join(run_dir, 'steps'),
    prompts_dir: path.join(run_dir, 'prompts'),
    starts_dir: path.join(run_dir, 'starts'),
    status_dir: path.join(run_dir, 'status'),
  }
}

export interface AppendRunnerEventInput {
  event_type: RunnerEventType
  step_id?: string
  details?: Record<string, unknown>
}

export interface StepFileReference {
  step_id: string
  ordinal: number
}

export interface StoreFileRef {
  kind: StoreEvidenceKind
  path: string
  relative_path: string
  attempt?: number
}

export interface WritePromptInput {
  step: StepFileReference
  attempt: number
  text: string
}

export interface WriteStartReportInput {
  step: StepFileReference
  attempt: number
  start_report: StepStartReport
}

export interface WriteStatusReportInput {
  step: StepFileReference
  attempt: number
  status_report: StatusReport
}

export interface RunInspection {
  run_instance_id: string
  run_dir: string
  state: RunState
  work_plan: WorkPlan
  events: RunnerEvent[]
  files: string[]
  latest_files: Partial<Record<StoreEvidenceKind, string>>
}

export interface RecoverRunResult {
  ok: boolean
  changed: boolean
  reason: string
  state?: RunState
}

export interface DeleteRunResult {
  ok: true
  deleted: true
  run_instance_id: string
  run_dir: string
}

export interface RunnerStoreDiagnostics {
  mode: 'json' | 'sqlite' | 'hybrid'
  sqlite?: SqliteIntegrityReport
  artifact_reconciliation?: RunArtifactReconciliationReport
  primary?: RunnerStoreDiagnostics
  legacy_json?: RunnerStoreDiagnostics
}

export interface SqliteIntegrityReport {
  schema_version: string
  foreign_keys_enabled: boolean
  foreign_key_violation_count: number
  migrated_from: string | null
  orphan_rows_removed: Record<string, number>
}

export interface RunnerStore {
  getDiagnostics(): Promise<RunnerStoreDiagnostics>
  createRun(input: CreateRunInput): Promise<StoredRun>
  listRuns(): Promise<RunListItem[]>
  loadRun(run_instance_id: string): Promise<StoredRun>
  writeState(state: RunState): Promise<void>
  appendEvent(run_instance_id: string, input: AppendRunnerEventInput): Promise<RunnerEvent>
  readEvents(run_instance_id: string, limit?: number): Promise<RunnerEvent[]>
  writeStepSnapshot(run_instance_id: string, step: ResolvedStep): Promise<StoreFileRef>
  writePrompt(run_instance_id: string, input: WritePromptInput): Promise<StoreFileRef>
  writeStartReport(run_instance_id: string, input: WriteStartReportInput): Promise<StoreFileRef>
  writeStatusReport(run_instance_id: string, input: WriteStatusReportInput): Promise<StoreFileRef>
  nextAttemptNumber(run_instance_id: string, step: StepFileReference): Promise<number>
  inspectRun(run_instance_id: string): Promise<RunInspection>
  recoverRun(run_instance_id: string, reason?: string): Promise<RecoverRunResult>
  deleteRun(run_instance_id: string): Promise<DeleteRunResult>
  getRunPaths(run_instance_id: string): RunPaths
  listParallelGroups(run_instance_id: string): Promise<ParallelGroupState[]>
  getParallelGroup(run_instance_id: string, group_id: string): Promise<ParallelGroupState>
  recordParallelPreflight(run_instance_id: string, input: RecordParallelPreflightInput): Promise<ParallelPreflightResult>
  grantParallelLeases(
    run_instance_id: string,
    group_id: string,
    input: GrantParallelLeasesInput,
  ): Promise<ParallelLeaseGrantResult>
  recordParallelHeartbeat(
    run_instance_id: string,
    group_id: string,
    lease_id: string,
    input?: RecordParallelHeartbeatInput,
  ): Promise<ParallelLeaseState>
  recordParallelAttemptResult(
    run_instance_id: string,
    group_id: string,
    input: RecordParallelAttemptResultInput,
  ): Promise<ParallelAttemptResultRecord>
  retryParallelItem(
    run_instance_id: string,
    group_id: string,
    item_id: string,
    input?: RetryParallelItemInput,
  ): Promise<RetryParallelItemResult>
  recoverStaleParallelLeases(
    run_instance_id: string,
    group_id: string,
    input?: RecoverStaleParallelLeasesInput,
  ): Promise<RecoverStaleParallelLeasesResult>
  controlParallelGroup(
    run_instance_id: string,
    group_id: string,
    action: ParallelGroupControlAction,
    input?: ControlParallelGroupInput,
  ): Promise<ParallelGroupState>
}

export class RunnerStoreError extends Error {
  readonly code: string
  readonly run_instance_id?: string
  readonly file_path?: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, options: Record<string, unknown> & { run_instance_id?: string; file_path?: string } = {}) {
    super(message)
    this.name = 'RunnerStoreError'
    this.code = code
    this.run_instance_id = options.run_instance_id
    this.file_path = options.file_path
    this.details = options
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatOrdinal(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RunnerStoreError('store.invalid_ordinal', `Invalid step ordinal: ${ordinal}.`)
  }

  return String(ordinal).padStart(4, '0')
}

function formatAttempt(attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RunnerStoreError('store.invalid_attempt', `Invalid attempt number: ${attempt}.`)
  }

  return String(attempt).padStart(3, '0')
}

function assertSafeRunInstanceId(run_instance_id: string): string {
  if (!RUN_INSTANCE_ID_PATTERN.test(run_instance_id)) {
    throw new RunnerStoreError(
      'store.invalid_run_instance_id',
      'run_instance_id may contain only lowercase letters, numbers, underscores, and hyphens.',
      { run_instance_id },
    )
  }

  if (run_instance_id.includes('..') || run_instance_id.includes('/') || run_instance_id.includes('\\')) {
    throw new RunnerStoreError('store.invalid_run_instance_id', 'run_instance_id must not contain path syntax.', {
      run_instance_id,
    })
  }

  return run_instance_id
}

function assertSafeParallelId(value: string, label: string): string {
  if (!PARALLEL_ID_PATTERN.test(value)) {
    throw new RunnerStoreError(
      'store.invalid_parallel_id',
      `${label} must start with a letter or number and contain only letters, numbers, underscores, or hyphens.`,
    )
  }

  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new RunnerStoreError('store.invalid_parallel_id', `${label} must not contain path syntax.`)
  }

  return value
}

function safeStepFileSegment(step_id: string): string {
  const cleaned = step_id.replace(/[^A-Za-z0-9_-]/g, '_')
  if (cleaned.length === 0 || cleaned.includes('..')) {
    throw new RunnerStoreError('store.invalid_step_id', `Step id cannot be used as an evidence file segment: ${step_id}.`)
  }

  return cleaned
}

function stepFilePrefix(step: StepFileReference): string {
  return `${formatOrdinal(step.ordinal)}_${safeStepFileSegment(step.step_id)}`
}

function safeGroupFileSegment(group_id: string): string {
  return safeStepFileSegment(group_id)
}

function normalizeRelativePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
}

function parallelItemSealedOutputTarget(step: ParallelGroupStep, item: ParallelGroupItem): string {
  const unit_id = item.sealed_output?.unit_id ?? item.item_id
  const primary_artifact = item.sealed_output?.primary_artifact ?? step.sealed_output_defaults.primary_artifact
  return normalizeRelativePath(`${step.sealed_output_defaults.base_dir}/${unit_id}/${primary_artifact}`)
}

function parallelGroupPreflightPath(paths: RunPaths, step: StepFileReference, group_id: string): string {
  return path.join(
    paths.steps_dir,
    stepFilePrefix(step),
    'parallel_groups',
    safeGroupFileSegment(group_id),
    'preflight.json',
  )
}

function parallelAttemptId(group_id: string, item_id: string, attempt_number: number): string {
  return `${safeGroupFileSegment(group_id)}_${safeGroupFileSegment(item_id)}_attempt_${formatAttempt(attempt_number)}`
}

function parallelAttemptRelativeDir(group_id: string, item_id: string, attempt_id: string): string {
  return [
    'parallel_groups',
    safeGroupFileSegment(group_id),
    'items',
    safeGroupFileSegment(item_id),
    'attempts',
    safeGroupFileSegment(attempt_id),
  ].join('/')
}

function parallelAttemptDir(paths: RunPaths, group_id: string, item_id: string, attempt_id: string): string {
  return path.join(paths.run_dir, parallelAttemptRelativeDir(group_id, item_id, attempt_id))
}

function parallelLeaseId(attempt_id: string): string {
  return `${safeGroupFileSegment(attempt_id)}_lease_${randomUUID()}`
}

function itemStatusForAttemptStatus(status: ParallelAttemptResultStatus): ParallelItemStatus {
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'blocked') {
    return 'blocked'
  }
  if (status === 'cancelled') {
    return 'needs_recovery'
  }
  return 'needs_recovery'
}

function isParallelItemAttentionStatus(status: ParallelItemStatus): boolean {
  return ['blocked', 'needs_recovery', 'cancelled', 'stopped'].includes(status)
}

function isActiveAttemptStatus(status: ParallelAttemptStatus): boolean {
  return status === 'leased' || status === 'running'
}

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return
  }

  throw new RunnerStoreError('store.path_escape', `Resolved path escapes runner root: ${candidate}.`, {
    file_path: candidate,
  })
}

async function readJsonFile(file_path: string, code: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(file_path, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    throw new RunnerStoreError(code, `Failed to read JSON file ${file_path}: ${String(error)}`, {
      file_path,
    })
  }
}

async function writeJsonOnce(file_path: string, value: unknown): Promise<void> {
  await fs.writeFile(file_path, formatJson(value), { encoding: 'utf8', flag: 'wx' })
}

async function writeTextOnce(file_path: string, value: string): Promise<void> {
  await fs.writeFile(file_path, value, { encoding: 'utf8', flag: 'wx' })
}

async function writeJsonAtomic(file_path: string, value: unknown): Promise<void> {
  const temp_path = `${file_path}.tmp.${process.pid}.${randomUUID()}`
  await fs.writeFile(temp_path, formatJson(value), 'utf8')
  await fs.rename(temp_path, file_path)
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = []

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entry_path = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(entry_path)
        continue
      }

      out.push(path.relative(root, entry_path).replace(/\\/g, '/'))
    }
  }

  await walk(root)
  return out.sort()
}

async function readDirIfExists(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    // Automatic requeue requires proof of absence. Permission, I/O, and other
    // ambiguous observations must follow the conservative attention path.
    return true
  }
}

function validateLoadedRunState(value: unknown, run_instance_id: string): RunState {
  if (!isRecord(value)) {
    throw new RunnerStoreError('store.state_invalid', 'state.json must contain an object.', { run_instance_id })
  }

  if (value.schema_version !== RUN_STATE_SCHEMA_VERSION) {
    throw new RunnerStoreError('store.state_invalid', `state.json schema_version must be ${RUN_STATE_SCHEMA_VERSION}.`, {
      run_instance_id,
    })
  }

  if (value.run_instance_id !== run_instance_id) {
    throw new RunnerStoreError('store.state_run_mismatch', 'state.json run_instance_id does not match run folder.', {
      run_instance_id,
    })
  }

  const state = value as unknown as RunState
  return {
    ...state,
    automation: normalizeAutomationSettings(state.automation),
  }
}

function normalizeAutomationSettings(input: unknown): RunAutomationSettings {
  if (!isRecord(input)) {
    return {
      auto_pickup: false,
      auto_advance: false,
    }
  }

  return {
    auto_pickup: input.auto_pickup === true,
    auto_advance: input.auto_advance === true,
  }
}

function validateLoadedWorkPlan(value: unknown, run_instance_id: string): WorkPlan {
  const result = validateWorkPlan(value)
  if (!result.ok) {
    throw new RunnerStoreError(
      'store.work_plan_invalid',
      `work_plan.json is invalid: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      { run_instance_id },
    )
  }

  return value as WorkPlan
}

function latestByPrefix(files: string[], prefix: string): string | undefined {
  return files
    .filter((file) => file.startsWith(prefix))
    .sort()
    .at(-1)
}

interface SqliteRunRow {
  run_instance_id: string
  run_dir: string
  work_plan_json: string
  state_json: string
  status: RunState['status']
  current_step_id: string | null
  current_step_ordinal: number | null
  automation_json: string
  updated_at: string
}

interface SqliteEventRow {
  event_id: string
  event_type: RunnerEventType
  run_instance_id: string
  step_id: string | null
  timestamp: string
  details_json: string
}

interface SqliteParallelGroupRow {
  run_instance_id: string
  step_id: string
  group_id: string
  ordinal: number
  status: ParallelGroupStatus
  executor: ParallelGroupStep['executor']
  contract_ref: string
  max_concurrency: number
  group_json: string
  preflight_status: ParallelPreflightStatus
  preflight_errors_json: string
  preflight_warnings_json: string
  preflight_result_json: string | null
  checked_at: string | null
  checked_by: string | null
}

interface SqliteParallelItemRow {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  label: string | null
  status: ParallelItemStatus
  input_ref: string
  contract_ref: string
  variables_json: string
  sealed_output_target: string
  latest_attempt_id: string | null
}

interface SqliteParallelAttemptRow {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  attempt_number: number
  status: ParallelAttemptStatus
  evidence_dir: string | null
  warnings_json: string
  created_at: string
  updated_at: string
}

interface SqliteParallelLeaseRow {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  lease_id: string
  executor_id: string
  status: ParallelLeaseStatus
  leased_at: string
  expires_at: string | null
  heartbeat_at: string | null
  created_at: string
  updated_at: string
}

function parallelLeaseTtlMs(row: SqliteParallelLeaseRow): number {
  if (row.expires_at === null) {
    return DEFAULT_PARALLEL_LEASE_TTL_MS
  }
  const basis = Date.parse(row.updated_at)
  const expires = Date.parse(row.expires_at)
  const ttl = expires - basis
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_PARALLEL_LEASE_TTL_MS
}

function effectiveParallelLeaseExpiryMs(row: SqliteParallelLeaseRow): number | null {
  if (row.expires_at !== null) {
    const expires = Date.parse(row.expires_at)
    return Number.isNaN(expires) ? null : expires
  }
  const basis = Date.parse(row.heartbeat_at ?? row.leased_at)
  return Number.isNaN(basis) ? null : basis + DEFAULT_PARALLEL_LEASE_TTL_MS
}

function parallelLeaseIsExpired(row: SqliteParallelLeaseRow, observed_at_ms: number): boolean {
  const expires_at_ms = effectiveParallelLeaseExpiryMs(row)
  return expires_at_ms !== null && expires_at_ms <= observed_at_ms
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function attemptDirectoryIsProvenAbsentSync(run_dir: string, attempt_dir: string): boolean {
  const resolvedRunDir = path.resolve(run_dir)
  const resolvedAttemptDir = path.resolve(attempt_dir)
  if (resolvedAttemptDir === resolvedRunDir || !pathIsInside(resolvedRunDir, resolvedAttemptDir)) {
    return false
  }

  let physicalRunDir: string
  try {
    physicalRunDir = realpathSync(resolvedRunDir)
    if (!statSync(physicalRunDir).isDirectory()) {
      return false
    }
  } catch {
    return false
  }

  const relativeParts = path.relative(resolvedRunDir, resolvedAttemptDir).split(path.sep).filter(Boolean)
  let current = resolvedRunDir
  for (const part of relativeParts) {
    current = path.join(current, part)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(current)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return true
      }
      return false
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      return false
    }
    try {
      if (!pathIsInside(physicalRunDir, realpathSync(current))) {
        return false
      }
    } catch {
      return false
    }
  }

  return false
}

function parseJsonText(file_path: string, value: string, code: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new RunnerStoreError(code, `Failed to parse JSON from ${file_path}: ${String(error)}`, {
      file_path,
    })
  }
}

function requiredWorkerCapabilitiesFromGroupJson(group_json: string): WorkerCapability[] {
  const parsed = parseJsonText('parallel_group.group_json', group_json, 'store.parallel_group_read_failed')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return []
  }

  const rawCapabilities = (parsed as { required_worker_capabilities?: unknown }).required_worker_capabilities
  const allowed = new Set<string>(WORKER_CAPABILITIES)
  const capabilities = (Array.isArray(rawCapabilities) ? rawCapabilities : []).filter(
    (capability): capability is WorkerCapability => typeof capability === 'string' && allowed.has(capability),
  )
  if ((parsed as { participation?: unknown }).participation === 'source_writer' && !capabilities.includes('source_writer')) {
    capabilities.push('source_writer')
  }
  return capabilities
}

function validateLoadedSqliteWorkPlan(row: SqliteRunRow): WorkPlan {
  return validateLoadedWorkPlan(
    parseJsonText(`${row.run_instance_id}:work_plan_json`, row.work_plan_json, 'store.work_plan_read_failed'),
    row.run_instance_id,
  )
}

function validateLoadedSqliteState(row: SqliteRunRow): RunState {
  return validateLoadedRunState(
    parseJsonText(`${row.run_instance_id}:state_json`, row.state_json, 'store.state_read_failed'),
    row.run_instance_id,
  )
}

function rowToListItem(row: SqliteRunRow): RunListItem {
  const automation = normalizeAutomationSettings(
    parseJsonText(`${row.run_instance_id}:automation_json`, row.automation_json, 'store.state_read_failed'),
  )
  return {
    run_instance_id: row.run_instance_id,
    status: row.status,
    current_step_id: row.current_step_id,
    current_step_ordinal: row.current_step_ordinal,
    automation,
    updated_at: row.updated_at,
  }
}

function parsePreflightChecks(row_id: string, value: string): ParallelPreflightCheck[] {
  const parsed = parseJsonText(row_id, value, 'store.parallel_preflight_read_failed')
  return Array.isArray(parsed) ? (parsed as ParallelPreflightCheck[]) : []
}

function parseAttemptWarnings(row_id: string, value: string): ParallelAttemptWarning[] {
  const parsed = parseJsonText(row_id, value, 'store.parallel_attempt_warnings_read_failed')
  return Array.isArray(parsed) ? (parsed as ParallelAttemptWarning[]) : []
}

function parseParallelItemVariables(row_id: string, value: string): Record<string, unknown> {
  const parsed = parseJsonText(row_id, value, 'store.parallel_item_variables_read_failed')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RunnerStoreError(
      'store.parallel_item_variables_read_failed',
      `Parallel item variables must be a JSON object: ${row_id}.`,
      { row_id },
    )
  }
  return parsed as Record<string, unknown>
}

function mergeAttemptWarnings(current: ParallelAttemptWarning[], next: ParallelAttemptWarning[]): ParallelAttemptWarning[] {
  const byCode = new Map<ParallelAttemptWarningCode, ParallelAttemptWarning>()
  for (const warning of current) {
    byCode.set(warning.code, warning)
  }
  for (const warning of next) {
    byCode.set(warning.code, warning)
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code))
}

export class SqliteRunnerStore implements RunnerStore {
  readonly runs_root: string
  readonly db_path: string
  private readonly now: () => Date
  private readonly event_id_factory: () => string
  private readonly artifact_lifecycle: RunArtifactLifecycle
  private readonly lifecycle_coordinator = new RunLifecycleCoordinator()
  private db_promise: Promise<SqliteDatabase> | null = null
  private write_queue: Promise<void> = Promise.resolve()
  private integrity_report: SqliteIntegrityReport | null = null
  private artifact_reconciliation: RunArtifactReconciliationReport | null = null

  constructor(options: SqliteRunnerStoreOptions = {}) {
    this.runs_root = path.resolve(options.runs_root ?? DEFAULT_PROTOCOL_RUNNER_RUNS_ROOT)
    this.db_path = path.resolve(options.db_path ?? DEFAULT_PROTOCOL_RUNNER_SQLITE_DB_PATH)
    this.now = options.now ?? (() => new Date())
    this.event_id_factory = options.event_id_factory ?? (() => randomUUID())
    this.artifact_lifecycle =
      options.artifact_lifecycle ?? new RunArtifactLifecycle({ runs_root: this.runs_root, now: this.now })

    mkdirSync(this.runs_root, { recursive: true })
    mkdirSync(path.dirname(this.db_path), { recursive: true })
  }

  async getDiagnostics(): Promise<RunnerStoreDiagnostics> {
    const db = await this.getDb()
    if (this.integrity_report === null) {
      throw new RunnerStoreError('store.integrity_report_missing', 'SQLite integrity report was not initialized.')
    }
    this.assertForeignKeysEnabled(db)
    const currentViolations = this.allRows<Record<string, SqliteValue>>(db, 'PRAGMA foreign_key_check')
    return {
      mode: 'sqlite',
      sqlite: {
        ...this.integrity_report,
        foreign_keys_enabled: true,
        foreign_key_violation_count: currentViolations.length,
      },
      ...(this.artifact_reconciliation === null
        ? {}
        : { artifact_reconciliation: this.artifact_reconciliation }),
    }
  }

  async hasRun(run_instance_id: string): Promise<boolean> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const db = await this.getDb()
    const row = this.getRow<{ present: number }>(db, 'SELECT 1 AS present FROM runs WHERE run_instance_id = ?', [
      safe_run_id,
    ])
    return row !== undefined
  }

  getRunPaths(run_instance_id: string): RunPaths {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const run_dir = path.resolve(this.runs_root, safe_run_id)
    assertInsideRoot(this.runs_root, run_dir)

    return runPathsForDir(run_dir)
  }

  async createRun(input: CreateRunInput): Promise<StoredRun> {
    const run_instance_id = assertSafeRunInstanceId(input.run_instance_id)
    const validation = validateWorkPlan(input.work_plan)
    if (!validation.ok) {
      throw new RunnerStoreError(
        'store.work_plan_invalid',
        `Cannot create run with invalid work plan: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; ')}`,
        { run_instance_id },
      )
    }
    return this.lifecycle_coordinator.run(async () => {
      await this.getDb()
      const finalPaths = this.getRunPaths(run_instance_id)
      if ((await this.hasRun(run_instance_id)) || (await pathExists(finalPaths.run_dir))) {
        throw new RunnerStoreError('store.run_exists', `Run already exists: ${run_instance_id}.`, { run_instance_id })
      }

      const transaction = await this.artifact_lifecycle.beginCreate(run_instance_id)
      const stagedPaths = runPathsForDir(transaction.staged_run_dir)
      let databaseCreated = false
      try {
        await Promise.all([
          fs.mkdir(stagedPaths.steps_dir),
          fs.mkdir(stagedPaths.prompts_dir),
          fs.mkdir(stagedPaths.starts_dir),
          fs.mkdir(stagedPaths.status_dir),
        ])
        await writeJsonOnce(stagedPaths.work_plan_path, input.work_plan)

        const created_at = this.now().toISOString()
        const first_step = resolveStepByOrdinal(input.work_plan, 1)
        const state: RunState = {
          schema_version: RUN_STATE_SCHEMA_VERSION,
          run_instance_id,
          work_plan_path: 'work_plan.json',
          status: 'draft',
          current_step_id: first_step?.step_id ?? null,
          current_step_ordinal: first_step?.ordinal ?? null,
          automation: normalizeAutomationSettings(input.automation),
          thread_binding: null,
          timestamps: {
            created_at,
            updated_at: created_at,
          },
        }
        await writeJsonAtomic(stagedPaths.state_path, state)
        const initialEvent: RunnerEvent = {
          event_id: this.event_id_factory(),
          event_type: 'plan_validated',
          run_instance_id,
          timestamp: this.now().toISOString(),
          details: {
            run_title: input.work_plan.run_title,
            step_count: input.work_plan.steps.length,
          },
        }
        await fs.writeFile(stagedPaths.events_path, `${JSON.stringify(initialEvent)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })

        await this.withWrite((db) => {
          this.insertRunGraph(db, run_instance_id, finalPaths, input.work_plan, state, initialEvent, created_at)
        })
        databaseCreated = true
        await this.artifact_lifecycle.commitCreate(transaction)
        return await this.loadRun(run_instance_id)
      } catch (error) {
        const ownsDatabaseState = databaseCreated || (await this.hasRun(run_instance_id))
        let cleanupError: unknown = null
        if (ownsDatabaseState) {
          try {
            await this.deleteRunGraph(run_instance_id)
          } catch (candidate) {
            cleanupError = candidate
          }
        }
        try {
          await this.artifact_lifecycle.rollbackCreate(transaction, ownsDatabaseState)
        } catch (candidate) {
          cleanupError ??= candidate
        }
        if (cleanupError !== null) {
          throw new RunnerStoreError(
            'store.create_rollback_failed',
            `Run creation failed and rollback was incomplete: ${String(cleanupError)}`,
            { run_instance_id, original_error: String(error) },
          )
        }
        throw error
      }
    })
  }

  private insertRunGraph(
    db: SqliteDatabase,
    run_instance_id: string,
    paths: RunPaths,
    work_plan: WorkPlan,
    state: RunState,
    initialEvent: RunnerEvent,
    created_at: string,
  ): void {
    this.runStatement(
      db,
      `INSERT INTO runs (
        run_instance_id,
        run_dir,
        work_plan_path,
        state_path,
        work_plan_json,
        state_json,
        status,
        current_step_id,
        current_step_ordinal,
        automation_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run_instance_id,
        paths.run_dir,
        'work_plan.json',
        'state.json',
        JSON.stringify(work_plan),
        JSON.stringify(state),
        state.status,
        state.current_step_id,
        state.current_step_ordinal,
        JSON.stringify(state.automation),
        created_at,
        created_at,
      ],
    )

    work_plan.steps.forEach((step, index) => {
      this.runStatement(
        db,
        `INSERT INTO run_steps (run_instance_id, step_id, ordinal, step_kind, step_json)
         VALUES (?, ?, ?, ?, ?)`,
        [run_instance_id, step.step_id, index + 1, step.step_kind, JSON.stringify(step)],
      )
      if (step.step_kind === 'parallel_group') {
        this.insertParallelGroupRows(db, run_instance_id, step, index + 1, created_at)
      }
    })

    this.runStatement(
      db,
      `INSERT INTO runner_events (event_id, run_instance_id, event_type, step_id, timestamp, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        initialEvent.event_id,
        initialEvent.run_instance_id,
        initialEvent.event_type,
        initialEvent.step_id ?? null,
        initialEvent.timestamp,
        JSON.stringify(initialEvent.details),
      ],
    )
  }

  private async deleteRunGraph(run_instance_id: string): Promise<void> {
    await this.withWrite((db) => {
      this.deleteRunGraphSync(db, run_instance_id)
    })
  }

  private deleteRunGraphSync(db: SqliteDatabase, run_instance_id: string): void {
    for (const table of RUN_DESCENDANT_TABLES) {
      this.runStatement(db, `DELETE FROM ${table} WHERE run_instance_id = ?`, [run_instance_id])
    }
    this.runStatement(db, 'DELETE FROM runs WHERE run_instance_id = ?', [run_instance_id])
    for (const table of [...RUN_DESCENDANT_TABLES, 'runs'] as const) {
      const row = this.getRow<{ row_count: number }>(
        db,
        `SELECT COUNT(*) AS row_count FROM ${table} WHERE run_instance_id = ?`,
        [run_instance_id],
      )
      if ((row?.row_count ?? 0) !== 0) {
        throw new RunnerStoreError(
          'store.run_delete_incomplete',
          `Run closeout left rows in ${table}: ${run_instance_id}.`,
          { run_instance_id, table, row_count: row?.row_count ?? 0 },
        )
      }
    }
  }

  async listRuns(): Promise<RunListItem[]> {
    const db = await this.getDb()
    const rows = this.allRows<SqliteRunRow>(
      db,
      `SELECT run_instance_id, run_dir, work_plan_json, state_json, status, current_step_id,
              current_step_ordinal, automation_json, updated_at
       FROM runs
       ORDER BY run_instance_id`,
    )
    return rows.map(rowToListItem)
  }

  async loadRun(run_instance_id: string): Promise<StoredRun> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const row = await this.loadRunRow(safe_run_id)
    const work_plan = validateLoadedSqliteWorkPlan(row)
    const state = validateLoadedSqliteState(row)

    if (state.current_step_id !== null && !work_plan.steps.some((step) => step.step_id === state.current_step_id)) {
      throw new RunnerStoreError('store.state_current_step_missing', 'SQLite current_step_id is not in work plan.', {
        run_instance_id,
      })
    }

    return {
      run_instance_id: safe_run_id,
      run_dir: row.run_dir,
      work_plan,
      state,
    }
  }

  async writeState(state: RunState): Promise<void> {
    const run_instance_id = assertSafeRunInstanceId(state.run_instance_id)
    const paths = this.getRunPaths(run_instance_id)
    await this.loadRunRow(run_instance_id)

    await this.withWrite((db) => {
      const changes = this.runStatement(
        db,
        `UPDATE runs
         SET state_json = ?,
             status = ?,
             current_step_id = ?,
             current_step_ordinal = ?,
             automation_json = ?,
             updated_at = ?
         WHERE run_instance_id = ?`,
        [
          JSON.stringify(state),
          state.status,
          state.current_step_id,
          state.current_step_ordinal,
          JSON.stringify(normalizeAutomationSettings(state.automation)),
          state.timestamps.updated_at,
          run_instance_id,
        ],
      )

      if (changes !== 1) {
        throw new RunnerStoreError('store.run_missing', `Run does not exist: ${run_instance_id}.`, { run_instance_id })
      }
    })
    await writeJsonAtomic(paths.state_path, state)
  }

  async appendEvent(run_instance_id: string, input: AppendRunnerEventInput): Promise<RunnerEvent> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    await this.loadRunRow(safe_run_id)
    const paths = this.getRunPaths(safe_run_id)
    const event: RunnerEvent = {
      event_id: this.event_id_factory(),
      event_type: input.event_type,
      run_instance_id: safe_run_id,
      ...(input.step_id !== undefined ? { step_id: input.step_id } : {}),
      timestamp: this.now().toISOString(),
      details: input.details ?? {},
    }

    await this.withWrite((db) => {
      this.runStatement(
        db,
        `INSERT INTO runner_events (event_id, run_instance_id, event_type, step_id, timestamp, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          event.event_id,
          event.run_instance_id,
          event.event_type,
          event.step_id ?? null,
          event.timestamp,
          JSON.stringify(event.details),
        ],
      )
    })
    await fs.appendFile(paths.events_path, `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }

  async readEvents(run_instance_id: string, limit?: number): Promise<RunnerEvent[]> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    await this.loadRunRow(safe_run_id)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new RunnerStoreError('store.invalid_event_limit', `Invalid event limit: ${limit}.`)
    }

    const db = await this.getDb()
    const rows =
      limit === undefined
        ? this.allRows<SqliteEventRow>(
            db,
            `SELECT event_id, event_type, run_instance_id, step_id, timestamp, details_json
             FROM runner_events
             WHERE run_instance_id = ?
             ORDER BY sequence_id`,
            [safe_run_id],
          )
        : this.allRows<SqliteEventRow>(
            db,
            `SELECT event_id, event_type, run_instance_id, step_id, timestamp, details_json
             FROM (
               SELECT sequence_id, event_id, event_type, run_instance_id, step_id, timestamp, details_json
               FROM runner_events
               WHERE run_instance_id = ?
               ORDER BY sequence_id DESC
               LIMIT ?
             )
             ORDER BY sequence_id`,
            [safe_run_id, limit],
          )

    return rows.map((row) => ({
      event_id: row.event_id,
      event_type: row.event_type,
      run_instance_id: row.run_instance_id,
      ...(row.step_id !== null ? { step_id: row.step_id } : {}),
      timestamp: row.timestamp,
      details: parseJsonText(`${row.run_instance_id}:event:${row.event_id}`, row.details_json, 'store.event_read_failed') as Record<
        string,
        unknown
      >,
    }))
  }

  async writeStepSnapshot(run_instance_id: string, step: ResolvedStep): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    await this.loadRunRow(run_instance_id)
    const file_name = `${stepFilePrefix(step)}.json`
    const file_path = path.join(paths.steps_dir, file_name)
    await writeJsonOnce(file_path, step)
    const ref = this.toFileRef('step', paths.run_dir, file_path)
    await this.recordEvidenceFile(run_instance_id, ref, { step_id: step.step_id, ordinal: step.ordinal })
    return ref
  }

  async writePrompt(run_instance_id: string, input: WritePromptInput): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    await this.loadRunRow(run_instance_id)
    const file_name = `${stepFilePrefix(input.step)}.attempt_${formatAttempt(input.attempt)}.md`
    const file_path = path.join(paths.prompts_dir, file_name)
    await writeTextOnce(file_path, input.text)
    const ref = this.toFileRef('prompt', paths.run_dir, file_path, input.attempt)
    await this.recordEvidenceFile(run_instance_id, ref, input.step)
    return ref
  }

  async writeStartReport(run_instance_id: string, input: WriteStartReportInput): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    await this.loadRunRow(run_instance_id)
    const file_name = `${stepFilePrefix(input.step)}.attempt_${formatAttempt(input.attempt)}.json`
    const file_path = path.join(paths.starts_dir, file_name)
    await fs.mkdir(paths.starts_dir, { recursive: true })
    await writeJsonOnce(file_path, input.start_report)
    const ref = this.toFileRef('start', paths.run_dir, file_path, input.attempt)
    await this.recordEvidenceFile(run_instance_id, ref, input.step)
    return ref
  }

  async writeStatusReport(run_instance_id: string, input: WriteStatusReportInput): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    await this.loadRunRow(run_instance_id)
    const file_name = `${stepFilePrefix(input.step)}.attempt_${formatAttempt(input.attempt)}.json`
    const file_path = path.join(paths.status_dir, file_name)
    await fs.mkdir(paths.status_dir, { recursive: true })
    await writeJsonOnce(file_path, input.status_report)
    const ref = this.toFileRef('status', paths.run_dir, file_path, input.attempt)
    await this.recordEvidenceFile(run_instance_id, ref, input.step)
    return ref
  }

  async nextAttemptNumber(run_instance_id: string, step: StepFileReference): Promise<number> {
    const paths = this.getRunPaths(run_instance_id)
    await this.loadRunRow(run_instance_id)
    const prefix = `${stepFilePrefix(step)}.attempt_`
    const dirs = [paths.prompts_dir, paths.starts_dir, paths.status_dir]
    let max_attempt = 0

    for (const dir of dirs) {
      const entries = await readDirIfExists(dir)
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) {
          continue
        }

        const match = /\.attempt_(\d{3})\./.exec(entry)
        if (match !== null) {
          max_attempt = Math.max(max_attempt, Number.parseInt(match[1], 10))
        }
      }
    }

    return max_attempt + 1
  }

  async inspectRun(run_instance_id: string): Promise<RunInspection> {
    const stored = await this.loadRun(run_instance_id)
    const events = await this.readEvents(run_instance_id)
    const files = await listFilesRecursive(stored.run_dir)

    return {
      run_instance_id,
      run_dir: stored.run_dir,
      state: stored.state,
      work_plan: stored.work_plan,
      events,
      files,
      latest_files: {
        step: latestByPrefix(files, 'steps/'),
        prompt: latestByPrefix(files, 'prompts/'),
        start: latestByPrefix(files, 'starts/'),
        status: latestByPrefix(files, 'status/'),
      },
    }
  }

  async recoverRun(run_instance_id: string, reason = 'startup recovery'): Promise<RecoverRunResult> {
    let stored: StoredRun
    try {
      stored = await this.loadRun(run_instance_id)
    } catch (error) {
      if (error instanceof RunnerStoreError) {
        return {
          ok: false,
          changed: false,
          reason: `Recovery blocked: ${error.message}`,
        }
      }

      throw error
    }

    if (stored.state.status !== 'running') {
      return {
        ok: true,
        changed: false,
        reason: `No recovery state change required for status=${stored.state.status}.`,
        state: stored.state,
      }
    }

    const updated_at = this.now().toISOString()
    const recovered_state: RunState = {
      ...stored.state,
      status: 'blocked',
      timestamps: {
        ...stored.state.timestamps,
        updated_at,
      },
    }

    await this.writeState(recovered_state)
    await this.appendEvent(run_instance_id, {
      event_type: 'state_changed',
      step_id: stored.state.current_step_id ?? undefined,
      details: {
        from_status: 'running',
        to_status: 'blocked',
        reason,
      },
    })

    return {
      ok: true,
      changed: true,
      reason,
      state: recovered_state,
    }
  }

  async deleteRun(run_instance_id: string): Promise<DeleteRunResult> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    return this.lifecycle_coordinator.run(async () => {
      await this.getDb()
      const paths = this.getRunPaths(safe_run_id)
      await this.loadRunRow(safe_run_id)
      const transaction = await this.artifact_lifecycle.beginRetire(safe_run_id)
      try {
        await this.deleteRunGraph(safe_run_id)
        await this.artifact_lifecycle.commitRetire(transaction)
      } catch (error) {
        if (await this.hasRun(safe_run_id)) {
          await this.artifact_lifecycle.rollbackRetire(transaction)
        } else if (await pathExists(transaction.transaction_dir)) {
          await this.artifact_lifecycle.commitRetire(transaction)
        }
        throw error
      }
      return {
        ok: true,
        deleted: true,
        run_instance_id: safe_run_id,
        run_dir: paths.run_dir,
      }
    })
  }

  async listParallelGroups(run_instance_id: string): Promise<ParallelGroupState[]> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    await this.loadRunRow(safe_run_id)
    const db = await this.getDb()
    const rows = this.allRows<SqliteParallelGroupRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, ordinal, status, executor, contract_ref,
              max_concurrency, group_json, preflight_status, preflight_errors_json,
              preflight_warnings_json, preflight_result_json, checked_at, checked_by
       FROM parallel_groups
       WHERE run_instance_id = ?
       ORDER BY ordinal, group_id`,
      [safe_run_id],
    )
    return Promise.all(rows.map((row) => this.rowToParallelGroupState(row)))
  }

  async getParallelGroup(run_instance_id: string, group_id: string): Promise<ParallelGroupState> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    await this.loadRunRow(safe_run_id)
    const row = await this.loadParallelGroupRow(safe_run_id, safe_group_id)
    return this.rowToParallelGroupState(row)
  }

  async recordParallelPreflight(
    run_instance_id: string,
    input: RecordParallelPreflightInput,
  ): Promise<ParallelPreflightResult> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(input.step.group_id, 'group_id')
    await this.loadRunRow(safe_run_id)
    await this.loadParallelGroupRow(safe_run_id, safe_group_id)

    const status: ParallelGroupStatus = input.result.passed ? 'ready_to_lease' : 'needs_attention'
    const preflight_status: ParallelPreflightStatus = input.result.passed ? 'passed' : 'failed'
    const paths = this.getRunPaths(safe_run_id)
    const preflight_path = parallelGroupPreflightPath(paths, this.stepFileReference(input.step), safe_group_id)
    await fs.mkdir(path.dirname(preflight_path), { recursive: true })

    const result_without_file: ParallelPreflightResult = {
      ...input.result,
      preflight_status,
      passed: input.result.passed,
    }
    await writeJsonAtomic(preflight_path, result_without_file)
    const evidence_file = this.toFileRef('parallel_preflight', paths.run_dir, preflight_path)
    const result: ParallelPreflightResult = {
      ...result_without_file,
      evidence_file,
    }
    await writeJsonAtomic(preflight_path, result)

    await this.withWrite((db) => {
      this.runStatement(
        db,
        `UPDATE parallel_groups
         SET status = ?,
             preflight_status = ?,
             preflight_errors_json = ?,
             preflight_warnings_json = ?,
             preflight_result_json = ?,
             checked_at = ?,
             checked_by = ?,
             updated_at = ?
         WHERE run_instance_id = ? AND group_id = ?`,
        [
          status,
          preflight_status,
          JSON.stringify(result.errors),
          JSON.stringify(result.warnings),
          JSON.stringify(result),
          result.checked_at,
          result.checked_by,
          result.checked_at,
          safe_run_id,
          safe_group_id,
        ],
      )
      this.recordEvidenceFileSync(db, safe_run_id, evidence_file, this.stepFileReference(input.step), {
        allow_existing: true,
      })
    })

    return result
  }

  async grantParallelLeases(
    run_instance_id: string,
    group_id: string,
    input: GrantParallelLeasesInput,
  ): Promise<ParallelLeaseGrantResult> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    const executor_id = assertSafeParallelId(input.executor_id, 'executor_id')
    if (!Number.isInteger(input.capacity) || input.capacity < 1) {
      throw new RunnerStoreError('store.parallel_invalid_capacity', 'capacity must be a positive integer.', {
        run_instance_id: safe_run_id,
        group_id: safe_group_id,
      })
    }
    const lease_ttl_ms = input.lease_ttl_ms ?? DEFAULT_PARALLEL_LEASE_TTL_MS
    if (!Number.isInteger(lease_ttl_ms) || lease_ttl_ms < 1) {
      throw new RunnerStoreError('store.parallel_invalid_lease_ttl', 'lease_ttl_ms must be a positive integer.', {
        run_instance_id: safe_run_id,
        group_id: safe_group_id,
      })
    }

    await this.loadRunRow(safe_run_id)
    const granted = await this.withWrite((db) => {
      const group = this.loadParallelGroupRowSync(db, safe_run_id, safe_group_id)
      if (group.preflight_status !== 'passed') {
        throw new RunnerStoreError(
          'store.parallel_preflight_required',
          `Parallel group ${safe_group_id} cannot lease work before preflight passes.`,
          { run_instance_id: safe_run_id },
        )
      }
      if (!['ready_to_lease', 'running', 'leasing'].includes(group.status)) {
        throw new RunnerStoreError(
          'store.parallel_group_not_leaseable',
          `Parallel group ${safe_group_id} cannot grant leases while status=${group.status}.`,
          { run_instance_id: safe_run_id },
        )
      }

      const activeCount = this.countActiveParallelLeases(db, safe_run_id, safe_group_id)
      const available = Math.max(0, Math.min(input.capacity, group.max_concurrency - activeCount))
      if (available === 0) {
        return [] as ParallelLeasePacket[]
      }

      const candidates = this.loadLeaseCandidateRows(db, safe_run_id, safe_group_id).slice(0, available)
      const leased_at = this.now().toISOString()
      const expires_at = new Date(Date.parse(leased_at) + lease_ttl_ms).toISOString()
      const paths = this.getRunPaths(safe_run_id)
      const packets: ParallelLeasePacket[] = []

      for (const item of candidates) {
        const existingAttempt = item.latest_attempt_id === null ? null : this.loadParallelAttemptRowSync(db, safe_run_id, item.latest_attempt_id)
        const attempt_number =
          existingAttempt !== null && existingAttempt.status === 'created'
            ? existingAttempt.attempt_number
            : this.nextParallelAttemptNumber(db, safe_run_id, safe_group_id, item.item_id)
        const attempt_id =
          existingAttempt !== null && existingAttempt.status === 'created'
            ? existingAttempt.attempt_id
            : parallelAttemptId(safe_group_id, item.item_id, attempt_number)
        const evidence_dir = parallelAttemptRelativeDir(safe_group_id, item.item_id, attempt_id)
        if (existingAttempt === null || existingAttempt.status !== 'created') {
          this.runStatement(
            db,
            `INSERT INTO parallel_attempts (
              run_instance_id, step_id, group_id, item_id, attempt_id, attempt_number,
              status, evidence_dir, warnings_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              safe_run_id,
              group.step_id,
              safe_group_id,
              item.item_id,
              attempt_id,
              attempt_number,
              'created',
              evidence_dir,
              '[]',
              leased_at,
              leased_at,
            ],
          )
        }

        const lease_id = parallelLeaseId(attempt_id)
        this.runStatement(
          db,
          `INSERT INTO parallel_leases (
            run_instance_id, step_id, group_id, item_id, attempt_id, lease_id,
            executor_id, status, leased_at, expires_at, heartbeat_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            safe_run_id,
            group.step_id,
            safe_group_id,
            item.item_id,
            attempt_id,
            lease_id,
            executor_id,
            'active',
            leased_at,
            expires_at,
            null,
            leased_at,
            leased_at,
          ],
        )
        this.runStatement(
          db,
          `UPDATE parallel_attempts
           SET status = ?, evidence_dir = ?, updated_at = ?
           WHERE run_instance_id = ? AND attempt_id = ?`,
          ['leased', evidence_dir, leased_at, safe_run_id, attempt_id],
        )
        this.runStatement(
          db,
          `UPDATE parallel_items
           SET status = ?, latest_attempt_id = ?, updated_at = ?
           WHERE run_instance_id = ? AND group_id = ? AND item_id = ?`,
          ['leased', attempt_id, leased_at, safe_run_id, safe_group_id, item.item_id],
        )

        packets.push(
          this.parallelLeasePacketFromParts(paths, {
            run_instance_id: safe_run_id,
            step_id: group.step_id,
            group_id: safe_group_id,
            item_id: item.item_id,
            attempt_id,
            lease_id,
            executor_id,
            status: 'active',
            leased_at,
            expires_at,
            heartbeat_at: null,
            created_at: leased_at,
            updated_at: leased_at,
          }, item, requiredWorkerCapabilitiesFromGroupJson(group.group_json)),
        )
      }

      if (packets.length > 0) {
        this.runStatement(
          db,
          `UPDATE parallel_groups
           SET status = ?, updated_at = ?
           WHERE run_instance_id = ? AND group_id = ?`,
          ['running', leased_at, safe_run_id, safe_group_id],
        )
      }

      return packets
    })

    return {
      group: await this.getParallelGroup(safe_run_id, safe_group_id),
      leases: granted,
    }
  }

  async recordParallelHeartbeat(
    run_instance_id: string,
    group_id: string,
    lease_id: string,
    input: RecordParallelHeartbeatInput = {},
  ): Promise<ParallelLeaseState> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    const safe_lease_id = assertSafeParallelId(lease_id, 'lease_id')
    await this.loadRunRow(safe_run_id)
    const heartbeatTimestamp = input.heartbeat_at !== undefined ? new Date(input.heartbeat_at) : this.now()
    if (Number.isNaN(heartbeatTimestamp.getTime())) {
      throw new RunnerStoreError('store.parallel_invalid_heartbeat_at', 'heartbeat_at must be an ISO timestamp.', {
        run_instance_id: safe_run_id,
        group_id: safe_group_id,
        lease_id: safe_lease_id,
      })
    }
    const heartbeat_at = heartbeatTimestamp.toISOString()
    let observed_at = ''
    let lease: ParallelLeaseState | null = null
    await this.withWrite((db) => {
      const observedTimestamp = this.now()
      observed_at = observedTimestamp.toISOString()
      const row = this.loadParallelLeaseRowSync(db, safe_run_id, safe_lease_id)
      if (row.group_id !== safe_group_id) {
        throw new RunnerStoreError('store.parallel_lease_group_mismatch', 'Lease does not belong to the requested group.', {
          run_instance_id: safe_run_id,
          group_id: safe_group_id,
        })
      }
      if (row.status !== 'active') {
        throw new RunnerStoreError('store.parallel_lease_not_active', `Cannot heartbeat lease status=${row.status}.`, {
          run_instance_id: safe_run_id,
          lease_id: safe_lease_id,
        })
      }
      if (parallelLeaseIsExpired(row, observedTimestamp.getTime())) {
        throw new RunnerStoreError('store.parallel_lease_expired', 'Cannot heartbeat an expired lease.', {
          run_instance_id: safe_run_id,
          lease_id: safe_lease_id,
          expires_at: row.expires_at,
        })
      }
      const previousHeartbeatAt = Date.parse(row.heartbeat_at ?? row.leased_at)
      if (!Number.isNaN(previousHeartbeatAt) && heartbeatTimestamp.getTime() < previousHeartbeatAt) {
        throw new RunnerStoreError('store.parallel_heartbeat_regressed', 'heartbeat_at cannot move backward.', {
          run_instance_id: safe_run_id,
          lease_id: safe_lease_id,
          previous_heartbeat_at: row.heartbeat_at ?? row.leased_at,
          heartbeat_at,
        })
      }
      const expires_at = new Date(observedTimestamp.getTime() + parallelLeaseTtlMs(row)).toISOString()
      const attemptRow = this.loadParallelAttemptRowSync(db, safe_run_id, row.attempt_id)
      this.runStatement(
        db,
        `UPDATE parallel_leases
         SET heartbeat_at = ?, expires_at = ?, updated_at = ?
         WHERE run_instance_id = ? AND lease_id = ?`,
        [heartbeat_at, expires_at, observed_at, safe_run_id, safe_lease_id],
      )
      this.runStatement(
        db,
        `UPDATE parallel_attempts
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND attempt_id = ? AND status = ?`,
        ['running', observed_at, safe_run_id, row.attempt_id, 'leased'],
      )
      this.runStatement(
        db,
        `UPDATE parallel_items
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ? AND item_id = ? AND status = ?`,
        ['running', observed_at, safe_run_id, safe_group_id, row.item_id, 'leased'],
      )
      if (input.attempt_warnings !== undefined && input.attempt_warnings.length > 0) {
        const warnings = mergeAttemptWarnings(
          parseAttemptWarnings(`${safe_run_id}:${row.attempt_id}:warnings_json`, attemptRow.warnings_json),
          input.attempt_warnings,
        )
        this.runStatement(
          db,
          `UPDATE parallel_attempts
           SET warnings_json = ?, updated_at = ?
           WHERE run_instance_id = ? AND attempt_id = ? AND status IN ('leased', 'running')`,
          [JSON.stringify(warnings), observed_at, safe_run_id, row.attempt_id],
        )
      }
      lease = this.rowToParallelLeaseState({
        ...row,
        expires_at,
        heartbeat_at,
        updated_at: observed_at,
      })
    })

    if (lease === null) {
      throw new RunnerStoreError('store.parallel_lease_missing', `Lease does not exist: ${safe_lease_id}.`, {
        run_instance_id: safe_run_id,
      })
    }
    return lease
  }

  async recordParallelAttemptResult(
    run_instance_id: string,
    group_id: string,
    input: RecordParallelAttemptResultInput,
  ): Promise<ParallelAttemptResultRecord> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    const safe_attempt_id = assertSafeParallelId(input.attempt_id, 'attempt_id')
    const safe_lease_id = assertSafeParallelId(input.lease_id, 'lease_id')
    await this.loadRunRow(safe_run_id)

    const item_status = itemStatusForAttemptStatus(input.status)
    let attempt: ParallelAttemptState | null = null
    let lease: ParallelLeaseState | null = null
    await this.withWrite((db) => {
      const observedTimestamp = this.now()
      const updated_at = observedTimestamp.toISOString()
      const attemptRow = this.loadParallelAttemptRowSync(db, safe_run_id, safe_attempt_id)
      const leaseRow = this.loadParallelLeaseRowSync(db, safe_run_id, safe_lease_id)
      if (attemptRow.group_id !== safe_group_id || leaseRow.group_id !== safe_group_id) {
        throw new RunnerStoreError('store.parallel_attempt_group_mismatch', 'Attempt or lease does not belong to the requested group.', {
          run_instance_id: safe_run_id,
          group_id: safe_group_id,
        })
      }
      if (leaseRow.attempt_id !== safe_attempt_id) {
        throw new RunnerStoreError('store.parallel_lease_attempt_mismatch', 'Lease does not belong to the requested attempt.', {
          run_instance_id: safe_run_id,
          lease_id: safe_lease_id,
          attempt_id: safe_attempt_id,
        })
      }
      if (leaseRow.status !== 'active') {
        throw new RunnerStoreError('store.parallel_lease_not_active', `Cannot record result for lease status=${leaseRow.status}.`, {
          run_instance_id: safe_run_id,
          lease_id: safe_lease_id,
        })
      }
      if (parallelLeaseIsExpired(leaseRow, observedTimestamp.getTime())) {
        throw new RunnerStoreError('store.parallel_lease_expired', 'Cannot record result for an expired lease.', {
          run_instance_id: safe_run_id,
          lease_id: safe_lease_id,
          expires_at: leaseRow.expires_at,
        })
      }
      if (!isActiveAttemptStatus(attemptRow.status)) {
        throw new RunnerStoreError('store.parallel_attempt_not_active', `Cannot record result for attempt status=${attemptRow.status}.`, {
          run_instance_id: safe_run_id,
          attempt_id: safe_attempt_id,
        })
      }

      this.runStatement(
        db,
        `UPDATE parallel_attempts
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND attempt_id = ?`,
        [input.status, updated_at, safe_run_id, safe_attempt_id],
      )
      this.runStatement(
        db,
        `UPDATE parallel_leases
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND lease_id = ?`,
        [input.status === 'cancelled' ? 'cancelled' : 'released', updated_at, safe_run_id, safe_lease_id],
      )
      this.runStatement(
        db,
        `UPDATE parallel_items
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ? AND item_id = ?`,
        [item_status, updated_at, safe_run_id, safe_group_id, attemptRow.item_id],
      )
      const group_status = this.computeParallelGroupStatus(db, safe_run_id, safe_group_id)
      this.runStatement(
        db,
        `UPDATE parallel_groups
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ?`,
        [group_status, updated_at, safe_run_id, safe_group_id],
      )

      attempt = this.rowToParallelAttemptState({
        ...attemptRow,
        status: input.status,
        updated_at,
      })
      lease = this.rowToParallelLeaseState({
        ...leaseRow,
        status: input.status === 'cancelled' ? 'cancelled' : 'released',
        updated_at,
      })
    })

    if (attempt === null) {
      throw new RunnerStoreError('store.parallel_attempt_missing', `Attempt does not exist: ${safe_attempt_id}.`, {
        run_instance_id: safe_run_id,
      })
    }
    return {
      group: await this.getParallelGroup(safe_run_id, safe_group_id),
      attempt,
      lease,
    }
  }

  async retryParallelItem(
    run_instance_id: string,
    group_id: string,
    item_id: string,
    _input: RetryParallelItemInput = {},
  ): Promise<RetryParallelItemResult> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    const safe_item_id = assertSafeParallelId(item_id, 'item_id')
    await this.loadRunRow(safe_run_id)
    const created_at = this.now().toISOString()
    let attempt: ParallelAttemptState | null = null
    let previous_attempt_id: string | null = null
    await this.withWrite((db) => {
      const item = this.loadParallelItemRowSync(db, safe_run_id, safe_group_id, safe_item_id)
      previous_attempt_id = item.latest_attempt_id
      if (!isParallelItemAttentionStatus(item.status)) {
        throw new RunnerStoreError('store.parallel_item_not_retryable', `Cannot retry item while status=${item.status}.`, {
          run_instance_id: safe_run_id,
          group_id: safe_group_id,
          item_id: safe_item_id,
        })
      }
      if (previous_attempt_id !== null) {
        const previous = this.loadParallelAttemptRowSync(db, safe_run_id, previous_attempt_id)
        if (isActiveAttemptStatus(previous.status)) {
          throw new RunnerStoreError(
            'store.parallel_attempt_still_active',
            `Cannot retry item while previous attempt status=${previous.status}.`,
            { run_instance_id: safe_run_id, attempt_id: previous_attempt_id },
          )
        }
      }

      const attempt_number = this.nextParallelAttemptNumber(db, safe_run_id, safe_group_id, safe_item_id)
      const attempt_id = parallelAttemptId(safe_group_id, safe_item_id, attempt_number)
      const evidence_dir = parallelAttemptRelativeDir(safe_group_id, safe_item_id, attempt_id)
        this.runStatement(
          db,
          `INSERT INTO parallel_attempts (
            run_instance_id, step_id, group_id, item_id, attempt_id, attempt_number,
            status, evidence_dir, warnings_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            safe_run_id,
            item.step_id,
          safe_group_id,
          safe_item_id,
          attempt_id,
            attempt_number,
            'created',
            evidence_dir,
            '[]',
            created_at,
            created_at,
          ],
      )
      this.runStatement(
        db,
        `UPDATE parallel_items
         SET status = ?, latest_attempt_id = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ? AND item_id = ?`,
        ['pending', attempt_id, created_at, safe_run_id, safe_group_id, safe_item_id],
      )
      this.runStatement(
        db,
        `UPDATE parallel_groups
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ?`,
        ['ready_to_lease', created_at, safe_run_id, safe_group_id],
      )
      attempt = {
        run_instance_id: safe_run_id,
        step_id: item.step_id,
        group_id: safe_group_id,
        item_id: safe_item_id,
        attempt_id,
        attempt_number,
        status: 'created',
        evidence_dir,
        latest_lease_id: null,
        warnings: [],
        created_at,
        updated_at: created_at,
      }
    })

    if (attempt === null) {
      throw new RunnerStoreError('store.parallel_attempt_missing', 'Retry did not create an attempt.', {
        run_instance_id: safe_run_id,
      })
    }
    return {
      group: await this.getParallelGroup(safe_run_id, safe_group_id),
      attempt,
      previous_attempt_id,
    }
  }

  async recoverStaleParallelLeases(
    run_instance_id: string,
    group_id: string,
    input: RecoverStaleParallelLeasesInput = {},
  ): Promise<RecoverStaleParallelLeasesResult> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    await this.loadRunRow(safe_run_id)
    const observedTimestamp = input.observed_at !== undefined ? new Date(input.observed_at) : this.now()
    if (Number.isNaN(observedTimestamp.getTime())) {
      throw new RunnerStoreError('store.parallel_invalid_observed_at', 'observed_at must be an ISO timestamp.', {
        run_instance_id: safe_run_id,
        group_id: safe_group_id,
      })
    }
    const observed_at = observedTimestamp.toISOString()

    const stale_lease_ids: string[] = []
    const stale_attempt_ids = new Set<string>()
    const stale_item_ids = new Set<string>()
    const requeued_lease_ids: string[] = []
    const requeued_attempt_ids = new Set<string>()
    const requeued_item_ids = new Set<string>()
    const attention_lease_ids: string[] = []
    const attention_attempt_ids = new Set<string>()
    const attention_item_ids = new Set<string>()
    const paths = this.getRunPaths(safe_run_id)
    await this.withWrite((db) => {
      const groupRow = this.loadParallelGroupRowSync(db, safe_run_id, safe_group_id)
      const staleRows = this.allRows<SqliteParallelLeaseRow>(
        db,
        `SELECT run_instance_id, step_id, group_id, item_id, attempt_id, lease_id, executor_id,
                status, leased_at, expires_at, heartbeat_at, created_at, updated_at
         FROM parallel_leases
         WHERE run_instance_id = ?
           AND group_id = ?
           AND status = 'active'
         ORDER BY leased_at, lease_id`,
        [safe_run_id, safe_group_id],
      ).filter((row) => parallelLeaseIsExpired(row, observedTimestamp.getTime()))

      for (const row of staleRows) {
        const attemptRow = this.loadParallelAttemptRowSync(db, safe_run_id, row.attempt_id)
        const attempt_dir = parallelAttemptDir(paths, safe_group_id, row.item_id, row.attempt_id)
        const can_requeue_without_new_attempt =
          attemptDirectoryIsProvenAbsentSync(paths.run_dir, attempt_dir) &&
          ['leased', 'running'].includes(attemptRow.status)
        stale_lease_ids.push(row.lease_id)
        this.runStatement(
          db,
          `UPDATE parallel_leases
           SET status = ?, updated_at = ?
           WHERE run_instance_id = ? AND lease_id = ? AND status = ?`,
          ['expired', observed_at, safe_run_id, row.lease_id, 'active'],
        )
        if (can_requeue_without_new_attempt) {
          requeued_lease_ids.push(row.lease_id)
          requeued_attempt_ids.add(row.attempt_id)
          requeued_item_ids.add(row.item_id)
          this.runStatement(
            db,
            `UPDATE parallel_attempts
             SET status = ?, warnings_json = ?, updated_at = ?
             WHERE run_instance_id = ? AND attempt_id = ? AND status IN ('leased', 'running')`,
            ['created', '[]', observed_at, safe_run_id, row.attempt_id],
          )
          this.runStatement(
            db,
            `UPDATE parallel_items
             SET status = ?, updated_at = ?
             WHERE run_instance_id = ? AND group_id = ? AND item_id = ? AND status IN ('leased', 'running')`,
            ['pending', observed_at, safe_run_id, safe_group_id, row.item_id],
          )
        } else {
          stale_attempt_ids.add(row.attempt_id)
          stale_item_ids.add(row.item_id)
          attention_lease_ids.push(row.lease_id)
          attention_attempt_ids.add(row.attempt_id)
          attention_item_ids.add(row.item_id)
          this.runStatement(
            db,
            `UPDATE parallel_attempts
             SET status = ?, updated_at = ?
             WHERE run_instance_id = ? AND attempt_id = ? AND status IN ('leased', 'running')`,
            ['stale', observed_at, safe_run_id, row.attempt_id],
          )
          this.runStatement(
            db,
            `UPDATE parallel_items
             SET status = ?, updated_at = ?
             WHERE run_instance_id = ? AND group_id = ? AND item_id = ? AND status IN ('leased', 'running')`,
            ['needs_recovery', observed_at, safe_run_id, safe_group_id, row.item_id],
          )
        }
      }

      if (staleRows.length > 0) {
        const group_status =
          groupRow.status === 'paused'
            ? 'paused'
            : this.computeParallelGroupStatus(db, safe_run_id, safe_group_id)
        this.runStatement(
          db,
          `UPDATE parallel_groups
           SET status = ?, updated_at = ?
           WHERE run_instance_id = ? AND group_id = ?`,
          [group_status, observed_at, safe_run_id, safe_group_id],
        )
      }
    })

    return {
      group: await this.getParallelGroup(safe_run_id, safe_group_id),
      observed_at,
      stale_lease_ids,
      stale_attempt_ids: [...stale_attempt_ids],
      stale_item_ids: [...stale_item_ids],
      requeued_lease_ids,
      requeued_attempt_ids: [...requeued_attempt_ids],
      requeued_item_ids: [...requeued_item_ids],
      attention_lease_ids,
      attention_attempt_ids: [...attention_attempt_ids],
      attention_item_ids: [...attention_item_ids],
    }
  }

  async controlParallelGroup(
    run_instance_id: string,
    group_id: string,
    action: ParallelGroupControlAction,
    _input: ControlParallelGroupInput = {},
  ): Promise<ParallelGroupState> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const safe_group_id = assertSafeParallelId(group_id, 'group_id')
    await this.loadRunRow(safe_run_id)
    const updated_at = this.now().toISOString()
    await this.withWrite((db) => {
      this.loadParallelGroupRowSync(db, safe_run_id, safe_group_id)
      if (action === 'pause') {
        this.runStatement(
          db,
          `UPDATE parallel_groups
           SET status = ?, updated_at = ?
           WHERE run_instance_id = ? AND group_id = ?`,
          ['paused', updated_at, safe_run_id, safe_group_id],
        )
        return
      }

      this.runStatement(
        db,
        `UPDATE parallel_leases
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ? AND status = ?`,
        ['cancelled', updated_at, safe_run_id, safe_group_id, 'active'],
      )
      this.runStatement(
        db,
        `UPDATE parallel_attempts
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ? AND status IN ('created', 'leased', 'running')`,
        ['cancelled', updated_at, safe_run_id, safe_group_id],
      )
      this.runStatement(
        db,
        `UPDATE parallel_items
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ? AND status != ?`,
        ['stopped', updated_at, safe_run_id, safe_group_id, 'completed'],
      )
      this.runStatement(
        db,
        `UPDATE parallel_groups
         SET status = ?, updated_at = ?
         WHERE run_instance_id = ? AND group_id = ?`,
        ['stopped', updated_at, safe_run_id, safe_group_id],
      )
    })
    return this.getParallelGroup(safe_run_id, safe_group_id)
  }

  async debugGetRunRow(run_instance_id: string): Promise<SqliteRunRow> {
    return this.loadRunRow(run_instance_id)
  }

  private async getDb(): Promise<SqliteDatabase> {
    this.db_promise ??= this.openDb()
    return this.db_promise
  }

  private async openDb(): Promise<SqliteDatabase> {
    const SQL = await initSqlJs()
    let data: Uint8Array | null = null
    try {
      data = await fs.readFile(this.db_path)
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }

    const db = data === null ? new SQL.Database() : new SQL.Database(data)
    this.initializeSchema(db)
    this.integrity_report = this.migrateAndVerifyIntegrity(db)
    await this.persistDb(db)
    this.artifact_reconciliation = await this.artifact_lifecycle.reconcile((run_instance_id) =>
      this.hasRunSync(db, run_instance_id),
    )
    return db
  }

  private migrateAndVerifyIntegrity(db: SqliteDatabase): SqliteIntegrityReport {
    this.assertForeignKeysEnabled(db)
    const schemaRow = this.getRow<{ value: string }>(
      db,
      "SELECT value FROM runner_schema WHERE key = 'schema_version'",
    )
    if (schemaRow === undefined) {
      throw new RunnerStoreError('store.schema_version_missing', 'SQLite runner schema version is missing.')
    }
    if (schemaRow.value !== '1' && schemaRow.value !== SQLITE_SCHEMA_VERSION) {
      throw new RunnerStoreError(
        'store.schema_version_unsupported',
        `Unsupported SQLite runner schema version: ${schemaRow.value}.`,
      )
    }

    const orphanRowsRemoved: Record<string, number> = {}
    let migratedFrom: string | null = null
    if (schemaRow.value === '1') {
      migratedFrom = '1'
      db.exec('BEGIN TRANSACTION;')
      try {
        for (const table of RUN_DESCENDANT_TABLES) {
          orphanRowsRemoved[table] = this.runStatement(
            db,
            `DELETE FROM ${table}
             WHERE NOT EXISTS (
               SELECT 1 FROM runs WHERE runs.run_instance_id = ${table}.run_instance_id
             )`,
          )
        }
        this.requireNoForeignKeyViolations(db)
        this.runStatement(
          db,
          "UPDATE runner_schema SET value = ? WHERE key = 'schema_version'",
          [SQLITE_SCHEMA_VERSION],
        )
        db.exec('COMMIT;')
      } catch (error) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          // Preserve the migration failure.
        }
        throw error
      }
    } else {
      for (const table of RUN_DESCENDANT_TABLES) {
        orphanRowsRemoved[table] = 0
      }
      this.requireNoForeignKeyViolations(db)
    }

    this.assertForeignKeysEnabled(db)
    return {
      schema_version: SQLITE_SCHEMA_VERSION,
      foreign_keys_enabled: true,
      foreign_key_violation_count: 0,
      migrated_from: migratedFrom,
      orphan_rows_removed: orphanRowsRemoved,
    }
  }

  private requireNoForeignKeyViolations(db: SqliteDatabase): void {
    const violations = this.allRows<Record<string, SqliteValue>>(db, 'PRAGMA foreign_key_check')
    if (violations.length !== 0) {
      throw new RunnerStoreError(
        'store.foreign_key_integrity_failed',
        `SQLite runner state contains ${violations.length} unresolved foreign-key violation(s).`,
        { violation_count: violations.length, violations: violations.slice(0, 20) },
      )
    }
  }

  private assertForeignKeysEnabled(db: SqliteDatabase): void {
    const row = this.getRow<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')
    if (row?.foreign_keys !== 1) {
      throw new RunnerStoreError('store.foreign_keys_disabled', 'SQLite foreign-key enforcement is disabled.')
    }
  }

  private hasRunSync(db: SqliteDatabase, run_instance_id: string): boolean {
    return this.getRow<{ present: number }>(db, 'SELECT 1 AS present FROM runs WHERE run_instance_id = ?', [
      run_instance_id,
    ]) !== undefined
  }

  private initializeSchema(db: SqliteDatabase): void {
    db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS runner_schema (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO runner_schema (key, value)
      VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS runs (
        run_instance_id TEXT PRIMARY KEY,
        run_dir TEXT NOT NULL,
        work_plan_path TEXT NOT NULL,
        state_path TEXT NOT NULL,
        work_plan_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step_id TEXT,
        current_step_ordinal INTEGER,
        automation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_steps (
        run_instance_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        step_kind TEXT NOT NULL,
        step_json TEXT NOT NULL,
        PRIMARY KEY (run_instance_id, step_id),
        FOREIGN KEY (run_instance_id) REFERENCES runs(run_instance_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runner_events (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_instance_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        step_id TEXT,
        timestamp TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY (run_instance_id) REFERENCES runs(run_instance_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS evidence_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        step_id TEXT,
        ordinal INTEGER,
        attempt INTEGER,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_instance_id, relative_path),
        FOREIGN KEY (run_instance_id) REFERENCES runs(run_instance_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS parallel_groups (
        run_instance_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        executor TEXT NOT NULL,
        contract_ref TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL,
        group_json TEXT NOT NULL,
        preflight_status TEXT NOT NULL,
        preflight_errors_json TEXT NOT NULL,
        preflight_warnings_json TEXT NOT NULL,
        preflight_result_json TEXT,
        checked_at TEXT,
        checked_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_instance_id, group_id),
        UNIQUE (run_instance_id, step_id),
        FOREIGN KEY (run_instance_id) REFERENCES runs(run_instance_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS parallel_items (
        run_instance_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL,
        input_ref TEXT NOT NULL,
        contract_ref TEXT NOT NULL,
        variables_json TEXT NOT NULL,
        sealed_output_json TEXT NOT NULL,
        sealed_output_target TEXT NOT NULL,
        latest_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_instance_id, group_id, item_id),
        UNIQUE (run_instance_id, group_id, sealed_output_target),
        FOREIGN KEY (run_instance_id, group_id)
          REFERENCES parallel_groups(run_instance_id, group_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS parallel_attempts (
        run_instance_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        evidence_dir TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_instance_id, attempt_id),
        UNIQUE (run_instance_id, group_id, item_id, attempt_number),
        FOREIGN KEY (run_instance_id, group_id, item_id)
          REFERENCES parallel_items(run_instance_id, group_id, item_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS parallel_leases (
        run_instance_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        status TEXT NOT NULL,
        leased_at TEXT NOT NULL,
        expires_at TEXT,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_instance_id, lease_id),
        FOREIGN KEY (run_instance_id, attempt_id)
          REFERENCES parallel_attempts(run_instance_id, attempt_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runner_events_run_sequence
        ON runner_events(run_instance_id, sequence_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_files_run_kind
        ON evidence_files(run_instance_id, kind);
      CREATE INDEX IF NOT EXISTS idx_parallel_groups_run_status
        ON parallel_groups(run_instance_id, status);
      CREATE INDEX IF NOT EXISTS idx_parallel_items_group_status
        ON parallel_items(run_instance_id, group_id, status);
      CREATE INDEX IF NOT EXISTS idx_parallel_attempts_item_status
        ON parallel_attempts(run_instance_id, group_id, item_id, status);
      CREATE INDEX IF NOT EXISTS idx_parallel_leases_group_status
        ON parallel_leases(run_instance_id, group_id, status);
    `)
    this.ensureColumn(db, 'parallel_attempts', 'warnings_json', "TEXT NOT NULL DEFAULT '[]'")
  }

  private ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
    const columns = this.allRows<{ name: string }>(db, `PRAGMA table_info(${table})`)
    if (columns.some((candidate) => candidate.name === column)) {
      return
    }
    this.runStatement(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private async loadRunRow(run_instance_id: string): Promise<SqliteRunRow> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const db = await this.getDb()
    const row = this.getRow<SqliteRunRow>(
      db,
      `SELECT run_instance_id, run_dir, work_plan_json, state_json, status, current_step_id,
              current_step_ordinal, automation_json, updated_at
       FROM runs
       WHERE run_instance_id = ?`,
      [safe_run_id],
    )

    if (row === undefined) {
      throw new RunnerStoreError('store.run_missing', `Run does not exist: ${safe_run_id}.`, {
        run_instance_id: safe_run_id,
      })
    }

    return row
  }

  private async recordEvidenceFile(run_instance_id: string, ref: StoreFileRef, step: StepFileReference): Promise<void> {
    await this.withWrite((db) => {
      this.recordEvidenceFileSync(db, run_instance_id, ref, step)
    })
  }

  private recordEvidenceFileSync(
    db: SqliteDatabase,
    run_instance_id: string,
    ref: StoreFileRef,
    step: StepFileReference,
    options: { allow_existing?: boolean } = {},
  ): void {
    this.runStatement(
      db,
      `${options.allow_existing === true ? 'INSERT OR IGNORE' : 'INSERT'} INTO evidence_files
       (run_instance_id, kind, step_id, ordinal, attempt, relative_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        run_instance_id,
        ref.kind,
        step.step_id,
        step.ordinal,
        ref.attempt ?? null,
        ref.relative_path,
        this.now().toISOString(),
      ],
    )
  }

  private async loadParallelGroupRow(run_instance_id: string, group_id: string): Promise<SqliteParallelGroupRow> {
    const db = await this.getDb()
    return this.loadParallelGroupRowSync(db, run_instance_id, group_id)
  }

  private loadParallelGroupRowSync(db: SqliteDatabase, run_instance_id: string, group_id: string): SqliteParallelGroupRow {
    const row = this.getRow<SqliteParallelGroupRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, ordinal, status, executor, contract_ref,
              max_concurrency, group_json, preflight_status, preflight_errors_json,
              preflight_warnings_json, preflight_result_json, checked_at, checked_by
       FROM parallel_groups
       WHERE run_instance_id = ? AND group_id = ?`,
      [run_instance_id, group_id],
    )
    if (row === undefined) {
      throw new RunnerStoreError('store.parallel_group_missing', `Parallel group does not exist: ${group_id}.`, {
        run_instance_id,
      })
    }

    return row
  }

  private async rowToParallelGroupState(row: SqliteParallelGroupRow): Promise<ParallelGroupState> {
    const preflightResult =
      row.preflight_result_json === null
        ? null
        : (parseJsonText(
            `${row.run_instance_id}:${row.group_id}:preflight_result_json`,
            row.preflight_result_json,
            'store.parallel_preflight_read_failed',
          ) as ParallelPreflightResult)
    return {
      run_instance_id: row.run_instance_id,
      step_id: row.step_id,
      group_id: row.group_id,
      ordinal: row.ordinal,
      status: row.status,
      executor: row.executor,
      contract_ref: row.contract_ref,
      max_concurrency: row.max_concurrency,
      required_worker_capabilities: requiredWorkerCapabilitiesFromGroupJson(row.group_json),
      preflight_status: row.preflight_status,
      checked_at: row.checked_at,
      checked_by: row.checked_by,
      preflight_errors: parsePreflightChecks(
        `${row.run_instance_id}:${row.group_id}:preflight_errors_json`,
        row.preflight_errors_json,
      ),
      preflight_warnings: parsePreflightChecks(
        `${row.run_instance_id}:${row.group_id}:preflight_warnings_json`,
        row.preflight_warnings_json,
      ),
      preflight_result: preflightResult,
      items: await this.loadParallelItemStates(row.run_instance_id, row.group_id),
      attempts: await this.loadParallelAttemptStates(row.run_instance_id, row.group_id),
      leases: await this.loadParallelLeaseStates(row.run_instance_id, row.group_id),
    }
  }

  private async loadParallelItemStates(run_instance_id: string, group_id: string): Promise<ParallelItemState[]> {
    const db = await this.getDb()
    const rows = this.allRows<SqliteParallelItemRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, item_id, label, status, input_ref,
              contract_ref, variables_json, sealed_output_target, latest_attempt_id
       FROM parallel_items
       WHERE run_instance_id = ? AND group_id = ?
       ORDER BY item_id`,
      [run_instance_id, group_id],
    )
    return rows.map((row) => ({
      run_instance_id: row.run_instance_id,
      step_id: row.step_id,
      group_id: row.group_id,
      item_id: row.item_id,
      ...(row.label !== null ? { label: row.label } : {}),
      status: row.status,
      input_ref: row.input_ref,
      contract_ref: row.contract_ref,
      sealed_output_target: row.sealed_output_target,
      latest_attempt_id: row.latest_attempt_id,
    }))
  }

  private loadParallelItemRowSync(
    db: SqliteDatabase,
    run_instance_id: string,
    group_id: string,
    item_id: string,
  ): SqliteParallelItemRow {
    const row = this.getRow<SqliteParallelItemRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, item_id, label, status, input_ref,
              contract_ref, variables_json, sealed_output_target, latest_attempt_id
       FROM parallel_items
       WHERE run_instance_id = ? AND group_id = ? AND item_id = ?`,
      [run_instance_id, group_id, item_id],
    )
    if (row === undefined) {
      throw new RunnerStoreError('store.parallel_item_missing', `Parallel item does not exist: ${item_id}.`, {
        run_instance_id,
        group_id,
      })
    }

    return row
  }

  private loadLeaseCandidateRows(
    db: SqliteDatabase,
    run_instance_id: string,
    group_id: string,
  ): SqliteParallelItemRow[] {
    return this.allRows<SqliteParallelItemRow>(
      db,
      `SELECT item.run_instance_id, item.step_id, item.group_id, item.item_id, item.label,
              item.status, item.input_ref, item.contract_ref, item.variables_json, item.sealed_output_target,
              item.latest_attempt_id
       FROM parallel_items AS item
       LEFT JOIN parallel_attempts AS attempt
         ON attempt.run_instance_id = item.run_instance_id
        AND attempt.attempt_id = item.latest_attempt_id
       WHERE item.run_instance_id = ?
         AND item.group_id = ?
         AND item.status = 'pending'
         AND NOT EXISTS (
           SELECT 1
           FROM parallel_leases AS lease
           WHERE lease.run_instance_id = item.run_instance_id
             AND lease.group_id = item.group_id
             AND lease.item_id = item.item_id
             AND lease.status = 'active'
         )
         AND (item.latest_attempt_id IS NULL OR attempt.status = 'created')
       ORDER BY item.item_id`,
      [run_instance_id, group_id],
    )
  }

  private async loadParallelAttemptStates(run_instance_id: string, group_id: string): Promise<ParallelAttemptState[]> {
    const db = await this.getDb()
    const rows = this.allRows<SqliteParallelAttemptRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, item_id, attempt_id, attempt_number,
              status, evidence_dir, warnings_json, created_at, updated_at
       FROM parallel_attempts
       WHERE run_instance_id = ? AND group_id = ?
       ORDER BY item_id, attempt_number`,
      [run_instance_id, group_id],
    )
    return rows.map((row) => this.rowToParallelAttemptState(row))
  }

  private loadParallelAttemptRowSync(
    db: SqliteDatabase,
    run_instance_id: string,
    attempt_id: string,
  ): SqliteParallelAttemptRow {
    const row = this.getRow<SqliteParallelAttemptRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, item_id, attempt_id, attempt_number,
              status, evidence_dir, warnings_json, created_at, updated_at
       FROM parallel_attempts
       WHERE run_instance_id = ? AND attempt_id = ?`,
      [run_instance_id, attempt_id],
    )
    if (row === undefined) {
      throw new RunnerStoreError('store.parallel_attempt_missing', `Parallel attempt does not exist: ${attempt_id}.`, {
        run_instance_id,
      })
    }

    return row
  }

  private rowToParallelAttemptState(row: SqliteParallelAttemptRow): ParallelAttemptState {
    return {
      run_instance_id: row.run_instance_id,
      step_id: row.step_id,
      group_id: row.group_id,
      item_id: row.item_id,
      attempt_id: row.attempt_id,
      attempt_number: row.attempt_number,
      status: row.status,
      evidence_dir: row.evidence_dir,
      latest_lease_id: null,
      warnings: parseAttemptWarnings(`${row.run_instance_id}:${row.attempt_id}:warnings_json`, row.warnings_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private async loadParallelLeaseStates(run_instance_id: string, group_id: string): Promise<ParallelLeaseState[]> {
    const db = await this.getDb()
    const rows = this.allRows<SqliteParallelLeaseRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, item_id, attempt_id, lease_id, executor_id,
              status, leased_at, expires_at, heartbeat_at, created_at, updated_at
       FROM parallel_leases
       WHERE run_instance_id = ? AND group_id = ?
       ORDER BY leased_at, lease_id`,
      [run_instance_id, group_id],
    )
    return rows.map((row) => this.rowToParallelLeaseState(row))
  }

  private loadParallelLeaseRowSync(db: SqliteDatabase, run_instance_id: string, lease_id: string): SqliteParallelLeaseRow {
    const row = this.getRow<SqliteParallelLeaseRow>(
      db,
      `SELECT run_instance_id, step_id, group_id, item_id, attempt_id, lease_id, executor_id,
              status, leased_at, expires_at, heartbeat_at, created_at, updated_at
       FROM parallel_leases
       WHERE run_instance_id = ? AND lease_id = ?`,
      [run_instance_id, lease_id],
    )
    if (row === undefined) {
      throw new RunnerStoreError('store.parallel_lease_missing', `Parallel lease does not exist: ${lease_id}.`, {
        run_instance_id,
      })
    }

    return row
  }

  private rowToParallelLeaseState(row: SqliteParallelLeaseRow): ParallelLeaseState {
    return {
      run_instance_id: row.run_instance_id,
      step_id: row.step_id,
      group_id: row.group_id,
      item_id: row.item_id,
      attempt_id: row.attempt_id,
      lease_id: row.lease_id,
      executor_id: row.executor_id,
      status: row.status,
      leased_at: row.leased_at,
      expires_at: row.expires_at,
      heartbeat_at: row.heartbeat_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private parallelLeasePacketFromParts(
    paths: RunPaths,
    lease: ParallelLeaseState,
    item: Pick<SqliteParallelItemRow, 'input_ref' | 'contract_ref' | 'variables_json' | 'sealed_output_target'>,
    required_worker_capabilities: WorkerCapability[],
  ): ParallelLeasePacket {
    const attempt_dir = parallelAttemptDir(paths, lease.group_id, lease.item_id, lease.attempt_id)
    return {
      ...lease,
      run_dir: paths.run_dir,
      attempt_dir,
      prompt_path: path.join(attempt_dir, 'prompt.md'),
      worker_packet_path: path.join(attempt_dir, 'worker_packet.json'),
      status_report_path: path.join(attempt_dir, 'status_report.json'),
      process_path: path.join(attempt_dir, 'process.json'),
      result_path: path.join(attempt_dir, 'result.json'),
      sealed_output_path: item.sealed_output_target,
      input_ref: item.input_ref,
      contract_ref: item.contract_ref,
      variables: parseParallelItemVariables(
        `${lease.run_instance_id}:${lease.group_id}:${lease.item_id}:variables_json`,
        item.variables_json,
      ),
      required_worker_capabilities,
    }
  }

  private countActiveParallelLeases(db: SqliteDatabase, run_instance_id: string, group_id: string): number {
    const row = this.getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count
       FROM parallel_leases
       WHERE run_instance_id = ? AND group_id = ? AND status = 'active'`,
      [run_instance_id, group_id],
    )
    return row?.count ?? 0
  }

  private nextParallelAttemptNumber(
    db: SqliteDatabase,
    run_instance_id: string,
    group_id: string,
    item_id: string,
  ): number {
    const row = this.getRow<{ max_attempt_number: number | null }>(
      db,
      `SELECT MAX(attempt_number) AS max_attempt_number
       FROM parallel_attempts
       WHERE run_instance_id = ? AND group_id = ? AND item_id = ?`,
      [run_instance_id, group_id, item_id],
    )
    return (row?.max_attempt_number ?? 0) + 1
  }

  private computeParallelGroupStatus(
    db: SqliteDatabase,
    run_instance_id: string,
    group_id: string,
  ): ParallelGroupStatus {
    const items = this.allRows<{ status: ParallelItemStatus }>(
      db,
      `SELECT status
       FROM parallel_items
       WHERE run_instance_id = ? AND group_id = ?`,
      [run_instance_id, group_id],
    )
    if (items.length > 0 && items.every((item) => item.status === 'completed')) {
      return 'completed'
    }
    if (items.some((item) => isParallelItemAttentionStatus(item.status))) {
      return 'needs_attention'
    }
    if (this.countActiveParallelLeases(db, run_instance_id, group_id) > 0) {
      return 'running'
    }
    if (items.some((item) => item.status === 'pending')) {
      return 'running'
    }
    return 'needs_attention'
  }

  private insertParallelGroupRows(
    db: SqliteDatabase,
    run_instance_id: string,
    step: ParallelGroupStep,
    ordinal: number,
    created_at: string,
  ): void {
    this.runStatement(
      db,
      `INSERT INTO parallel_groups (
        run_instance_id, step_id, group_id, ordinal, status, executor, contract_ref,
        max_concurrency, group_json, preflight_status, preflight_errors_json,
        preflight_warnings_json, preflight_result_json, checked_at, checked_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run_instance_id,
        step.step_id,
        step.group_id,
        ordinal,
        'pending',
        step.executor,
        step.contract_ref,
        step.max_concurrency,
        JSON.stringify(step),
        'not_run',
        '[]',
        '[]',
        null,
        null,
        null,
        created_at,
        created_at,
      ],
    )

    step.items.forEach((item) => {
      this.runStatement(
        db,
        `INSERT INTO parallel_items (
          run_instance_id, step_id, group_id, item_id, label, status, input_ref,
          contract_ref, variables_json, sealed_output_json, sealed_output_target,
          latest_attempt_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run_instance_id,
          step.step_id,
          step.group_id,
          item.item_id,
          item.label ?? null,
          'pending',
          item.input_ref,
          item.contract_ref ?? step.contract_ref,
          JSON.stringify(item.variables ?? {}),
          JSON.stringify(item.sealed_output ?? {}),
          parallelItemSealedOutputTarget(step, item),
          null,
          created_at,
          created_at,
        ],
      )
    })
  }

  private stepFileReference(step: StepFileReference): StepFileReference {
    return {
      step_id: step.step_id,
      ordinal: step.ordinal,
    }
  }

  private toFileRef(kind: StoreEvidenceKind, run_dir: string, file_path: string, attempt?: number): StoreFileRef {
    assertInsideRoot(run_dir, file_path)

    return {
      kind,
      path: file_path,
      relative_path: path.relative(run_dir, file_path).replace(/\\/g, '/'),
      ...(attempt !== undefined ? { attempt } : {}),
    }
  }

  private getRow<T>(
    db: SqliteDatabase,
    sql: string,
    params: SqliteValue[] = [],
  ): T | undefined {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params)
      if (!stmt.step()) {
        return undefined
      }
      return stmt.getAsObject() as T
    } finally {
      stmt.free()
    }
  }

  private allRows<T>(
    db: SqliteDatabase,
    sql: string,
    params: SqliteValue[] = [],
  ): T[] {
    const stmt = db.prepare(sql)
    const rows: T[] = []
    try {
      stmt.bind(params)
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  private runStatement(db: SqliteDatabase, sql: string, params: SqliteValue[] = []): number {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params)
      stmt.step()
      return db.getRowsModified()
    } finally {
      stmt.free()
    }
  }

  private async withWrite<T>(operation: (db: SqliteDatabase) => T): Promise<T> {
    const prior_write = this.write_queue.catch(() => undefined)
    const current_write = prior_write.then(async () => {
      const db = await this.getDb()
      db.exec('BEGIN TRANSACTION;')
      try {
        const result = operation(db)
        db.exec('COMMIT;')
        await this.persistDb(db)
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          // Ignore rollback errors; preserve the original failure.
        }
        throw error
      }
    })
    this.write_queue = current_write.then(
      () => undefined,
      () => undefined,
    )
    return current_write
  }

  private async persistDb(db: SqliteDatabase): Promise<void> {
    const temp_path = `${this.db_path}.tmp.${process.pid}.${randomUUID()}`
    const bytes = db.export()
    db.exec('PRAGMA foreign_keys = ON;')
    this.assertForeignKeysEnabled(db)
    try {
      await fs.writeFile(temp_path, bytes)
      await fs.rename(temp_path, this.db_path)
    } catch (error) {
      await fs.rm(temp_path, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export class JsonRunnerStore implements RunnerStore {
  readonly runs_root: string
  private readonly now: () => Date
  private readonly event_id_factory: () => string
  private readonly artifact_lifecycle: RunArtifactLifecycle
  private readonly lifecycle_coordinator = new RunLifecycleCoordinator()
  private reconcile_promise: Promise<RunArtifactReconciliationReport> | null = null
  private artifact_reconciliation: RunArtifactReconciliationReport | null = null

  constructor(options: JsonRunnerStoreOptions = {}) {
    this.runs_root = path.resolve(options.runs_root ?? DEFAULT_PROTOCOL_RUNNER_RUNS_ROOT)
    this.now = options.now ?? (() => new Date())
    this.event_id_factory = options.event_id_factory ?? (() => randomUUID())
    this.artifact_lifecycle =
      options.artifact_lifecycle ?? new RunArtifactLifecycle({ runs_root: this.runs_root, now: this.now })

    // Root creation is an owner-internal initialization effect. Keep it at
    // store construction, before the service readiness preflight and listener,
    // so an otherwise observational list request never creates filesystem
    // state after the API becomes reachable.
    mkdirSync(this.runs_root, { recursive: true })
  }

  async getDiagnostics(): Promise<RunnerStoreDiagnostics> {
    await this.ensureReconciled()
    return {
      mode: 'json',
      ...(this.artifact_reconciliation === null
        ? {}
        : { artifact_reconciliation: this.artifact_reconciliation }),
    }
  }

  private async ensureReconciled(): Promise<RunArtifactReconciliationReport> {
    this.reconcile_promise ??= this.artifact_lifecycle.reconcile(() => false)
    this.artifact_reconciliation = await this.reconcile_promise
    return this.artifact_reconciliation
  }

  getRunPaths(run_instance_id: string): RunPaths {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    const run_dir = path.resolve(this.runs_root, safe_run_id)
    assertInsideRoot(this.runs_root, run_dir)

    return runPathsForDir(run_dir)
  }

  async createRun(input: CreateRunInput): Promise<StoredRun> {
    const run_instance_id = assertSafeRunInstanceId(input.run_instance_id)
    const validation = validateWorkPlan(input.work_plan)
    if (!validation.ok) {
      throw new RunnerStoreError(
        'store.work_plan_invalid',
        `Cannot create run with invalid work plan: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; ')}`,
        { run_instance_id },
      )
    }

    return this.lifecycle_coordinator.run(async () => {
      await this.ensureReconciled()
      const finalPaths = this.getRunPaths(run_instance_id)
      if (await pathExists(finalPaths.run_dir)) {
        throw new RunnerStoreError('store.run_exists', `Run already exists: ${run_instance_id}.`, { run_instance_id })
      }
      const transaction = await this.artifact_lifecycle.beginCreate(run_instance_id)
      const stagedPaths = runPathsForDir(transaction.staged_run_dir)
      try {
        await Promise.all([
          fs.mkdir(stagedPaths.steps_dir),
          fs.mkdir(stagedPaths.prompts_dir),
          fs.mkdir(stagedPaths.starts_dir),
          fs.mkdir(stagedPaths.status_dir),
        ])
        await writeJsonOnce(stagedPaths.work_plan_path, input.work_plan)

        const created_at = this.now().toISOString()
        const first_step = resolveStepByOrdinal(input.work_plan, 1)
        const state: RunState = {
          schema_version: RUN_STATE_SCHEMA_VERSION,
          run_instance_id,
          work_plan_path: 'work_plan.json',
          status: 'draft',
          current_step_id: first_step?.step_id ?? null,
          current_step_ordinal: first_step?.ordinal ?? null,
          automation: normalizeAutomationSettings(input.automation),
          thread_binding: null,
          timestamps: {
            created_at,
            updated_at: created_at,
          },
        }

        await writeJsonAtomic(stagedPaths.state_path, state)
        const initialEvent: RunnerEvent = {
          event_id: this.event_id_factory(),
          event_type: 'plan_validated',
          run_instance_id,
          timestamp: this.now().toISOString(),
          details: {
            run_title: input.work_plan.run_title,
            step_count: input.work_plan.steps.length,
          },
        }
        await fs.writeFile(stagedPaths.events_path, `${JSON.stringify(initialEvent)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        await this.artifact_lifecycle.commitCreate(transaction)
        return await this.loadRun(run_instance_id)
      } catch (error) {
        await this.artifact_lifecycle.rollbackCreate(transaction, await pathExists(transaction.final_run_dir))
        throw error
      }
    })
  }

  async listRuns(): Promise<RunListItem[]> {
    await this.ensureReconciled()
    const entries = await fs.readdir(this.runs_root, { withFileTypes: true })
    const runs: RunListItem[] = []

    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_INSTANCE_ID_PATTERN.test(entry.name)) {
        continue
      }

      const stored = await this.loadRun(entry.name)
      runs.push({
        run_instance_id: stored.run_instance_id,
        status: stored.state.status,
        current_step_id: stored.state.current_step_id,
        current_step_ordinal: stored.state.current_step_ordinal,
        automation: stored.state.automation,
        updated_at: stored.state.timestamps.updated_at,
      })
    }

    return runs.sort((left, right) => left.run_instance_id.localeCompare(right.run_instance_id))
  }

  async loadRun(run_instance_id: string): Promise<StoredRun> {
    await this.ensureReconciled()
    const paths = this.getRunPaths(run_instance_id)
    const work_plan = validateLoadedWorkPlan(
      await readJsonFile(paths.work_plan_path, 'store.work_plan_read_failed'),
      run_instance_id,
    )
    const state = validateLoadedRunState(await readJsonFile(paths.state_path, 'store.state_read_failed'), run_instance_id)

    if (state.current_step_id !== null && !work_plan.steps.some((step) => step.step_id === state.current_step_id)) {
      throw new RunnerStoreError('store.state_current_step_missing', 'state.json current_step_id is not in work_plan.json.', {
        run_instance_id,
      })
    }

    return {
      run_instance_id,
      run_dir: paths.run_dir,
      work_plan,
      state,
    }
  }

  async writeState(state: RunState): Promise<void> {
    const paths = this.getRunPaths(state.run_instance_id)
    const current = await this.loadRun(state.run_instance_id)
    if (state.run_instance_id !== current.run_instance_id) {
      throw new RunnerStoreError('store.state_run_mismatch', 'state run_instance_id does not match loaded run.')
    }

    await writeJsonAtomic(paths.state_path, state)
  }

  async appendEvent(run_instance_id: string, input: AppendRunnerEventInput): Promise<RunnerEvent> {
    const paths = this.getRunPaths(run_instance_id)
    const event: RunnerEvent = {
      event_id: this.event_id_factory(),
      event_type: input.event_type,
      run_instance_id,
      ...(input.step_id !== undefined ? { step_id: input.step_id } : {}),
      timestamp: this.now().toISOString(),
      details: input.details ?? {},
    }

    await fs.appendFile(paths.events_path, `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }

  async readEvents(run_instance_id: string, limit?: number): Promise<RunnerEvent[]> {
    const paths = this.getRunPaths(run_instance_id)
    let raw = ''
    try {
      raw = await fs.readFile(paths.events_path, 'utf8')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return []
      }

      throw error
    }

    const events = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunnerEvent)

    if (limit === undefined) {
      return events
    }

    if (!Number.isInteger(limit) || limit < 1) {
      throw new RunnerStoreError('store.invalid_event_limit', `Invalid event limit: ${limit}.`)
    }

    return events.slice(-limit)
  }

  async writeStepSnapshot(run_instance_id: string, step: ResolvedStep): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    const file_name = `${stepFilePrefix(step)}.json`
    const file_path = path.join(paths.steps_dir, file_name)
    await writeJsonOnce(file_path, step)
    return this.toFileRef('step', paths.run_dir, file_path)
  }

  async writePrompt(run_instance_id: string, input: WritePromptInput): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    const file_name = `${stepFilePrefix(input.step)}.attempt_${formatAttempt(input.attempt)}.md`
    const file_path = path.join(paths.prompts_dir, file_name)
    await writeTextOnce(file_path, input.text)
    return this.toFileRef('prompt', paths.run_dir, file_path, input.attempt)
  }

  async writeStartReport(run_instance_id: string, input: WriteStartReportInput): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    const file_name = `${stepFilePrefix(input.step)}.attempt_${formatAttempt(input.attempt)}.json`
    const file_path = path.join(paths.starts_dir, file_name)
    await fs.mkdir(paths.starts_dir, { recursive: true })
    await writeJsonOnce(file_path, input.start_report)
    return this.toFileRef('start', paths.run_dir, file_path, input.attempt)
  }

  async writeStatusReport(run_instance_id: string, input: WriteStatusReportInput): Promise<StoreFileRef> {
    const paths = this.getRunPaths(run_instance_id)
    const file_name = `${stepFilePrefix(input.step)}.attempt_${formatAttempt(input.attempt)}.json`
    const file_path = path.join(paths.status_dir, file_name)
    await fs.mkdir(paths.status_dir, { recursive: true })
    await writeJsonOnce(file_path, input.status_report)
    return this.toFileRef('status', paths.run_dir, file_path, input.attempt)
  }

  async nextAttemptNumber(run_instance_id: string, step: StepFileReference): Promise<number> {
    const paths = this.getRunPaths(run_instance_id)
    const prefix = `${stepFilePrefix(step)}.attempt_`
    const dirs = [paths.prompts_dir, paths.starts_dir, paths.status_dir]
    let max_attempt = 0

    for (const dir of dirs) {
      const entries = await readDirIfExists(dir)
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) {
          continue
        }

        const match = /\.attempt_(\d{3})\./.exec(entry)
        if (match !== null) {
          max_attempt = Math.max(max_attempt, Number.parseInt(match[1], 10))
        }
      }
    }

    return max_attempt + 1
  }

  async inspectRun(run_instance_id: string): Promise<RunInspection> {
    const stored = await this.loadRun(run_instance_id)
    const events = await this.readEvents(run_instance_id)
    const files = await listFilesRecursive(stored.run_dir)

    return {
      run_instance_id,
      run_dir: stored.run_dir,
      state: stored.state,
      work_plan: stored.work_plan,
      events,
      files,
      latest_files: {
        step: latestByPrefix(files, 'steps/'),
        prompt: latestByPrefix(files, 'prompts/'),
        start: latestByPrefix(files, 'starts/'),
        status: latestByPrefix(files, 'status/'),
      },
    }
  }

  async recoverRun(run_instance_id: string, reason = 'startup recovery'): Promise<RecoverRunResult> {
    let stored: StoredRun
    try {
      stored = await this.loadRun(run_instance_id)
    } catch (error) {
      if (error instanceof RunnerStoreError) {
        return {
          ok: false,
          changed: false,
          reason: `Recovery blocked: ${error.message}`,
        }
      }

      throw error
    }

    if (stored.state.status !== 'running') {
      return {
        ok: true,
        changed: false,
        reason: `No recovery state change required for status=${stored.state.status}.`,
        state: stored.state,
      }
    }

    const updated_at = this.now().toISOString()
    const recovered_state: RunState = {
      ...stored.state,
      status: 'blocked',
      timestamps: {
        ...stored.state.timestamps,
        updated_at,
      },
    }

    await writeJsonAtomic(this.getRunPaths(run_instance_id).state_path, recovered_state)
    await this.appendEvent(run_instance_id, {
      event_type: 'state_changed',
      step_id: stored.state.current_step_id ?? undefined,
      details: {
        from_status: 'running',
        to_status: 'blocked',
        reason,
      },
    })

    return {
      ok: true,
      changed: true,
      reason,
      state: recovered_state,
    }
  }

  async deleteRun(run_instance_id: string): Promise<DeleteRunResult> {
    const safe_run_id = assertSafeRunInstanceId(run_instance_id)
    return this.lifecycle_coordinator.run(async () => {
      await this.ensureReconciled()
      const paths = this.getRunPaths(safe_run_id)
      await this.loadRun(safe_run_id)
      const transaction = await this.artifact_lifecycle.beginRetire(safe_run_id)
      try {
        await this.artifact_lifecycle.commitRetire(transaction)
      } catch (error) {
        if (await pathExists(transaction.transaction_dir)) {
          await this.artifact_lifecycle.rollbackRetire(transaction)
        }
        throw error
      }
      return {
        ok: true,
        deleted: true,
        run_instance_id: safe_run_id,
        run_dir: paths.run_dir,
      }
    })
  }

  async listParallelGroups(_run_instance_id: string): Promise<ParallelGroupState[]> {
    return []
  }

  async getParallelGroup(run_instance_id: string, group_id: string): Promise<ParallelGroupState> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      `Parallel group state is unavailable for JSON-backed legacy runs: ${group_id}.`,
      { run_instance_id },
    )
  }

  async recordParallelPreflight(
    run_instance_id: string,
    _input: RecordParallelPreflightInput,
  ): Promise<ParallelPreflightResult> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel preflight requires SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  async grantParallelLeases(
    run_instance_id: string,
    _group_id: string,
    _input: GrantParallelLeasesInput,
  ): Promise<ParallelLeaseGrantResult> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel leasing requires SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  async recordParallelHeartbeat(
    run_instance_id: string,
    _group_id: string,
    _lease_id: string,
    _input: RecordParallelHeartbeatInput = {},
  ): Promise<ParallelLeaseState> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel heartbeat requires SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  async recordParallelAttemptResult(
    run_instance_id: string,
    _group_id: string,
    _input: RecordParallelAttemptResultInput,
  ): Promise<ParallelAttemptResultRecord> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel attempt results require SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  async retryParallelItem(
    run_instance_id: string,
    _group_id: string,
    _item_id: string,
    _input: RetryParallelItemInput = {},
  ): Promise<RetryParallelItemResult> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel item retry requires SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  async recoverStaleParallelLeases(
    run_instance_id: string,
    _group_id: string,
    _input: RecoverStaleParallelLeasesInput = {},
  ): Promise<RecoverStaleParallelLeasesResult> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel stale-lease recovery requires SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  async controlParallelGroup(
    run_instance_id: string,
    _group_id: string,
    _action: ParallelGroupControlAction,
    _input: ControlParallelGroupInput = {},
  ): Promise<ParallelGroupState> {
    throw new RunnerStoreError(
      'store.parallel_state_unavailable',
      'Parallel group control requires SQLite-backed runner state.',
      { run_instance_id },
    )
  }

  private toFileRef(kind: StoreEvidenceKind, run_dir: string, file_path: string, attempt?: number): StoreFileRef {
    assertInsideRoot(run_dir, file_path)

    return {
      kind,
      path: file_path,
      relative_path: path.relative(run_dir, file_path).replace(/\\/g, '/'),
      ...(attempt !== undefined ? { attempt } : {}),
    }
  }
}

export class HybridRunnerStore implements RunnerStore {
  private readonly primary: SqliteRunnerStore
  private readonly legacy_json: JsonRunnerStore

  constructor(options: HybridRunnerStoreOptions) {
    this.primary = options.primary
    this.legacy_json = options.legacy_json
  }

  async getDiagnostics(): Promise<RunnerStoreDiagnostics> {
    return {
      mode: 'hybrid',
      primary: await this.primary.getDiagnostics(),
      legacy_json: await this.legacy_json.getDiagnostics(),
    }
  }

  getRunPaths(run_instance_id: string): RunPaths {
    return this.primary.getRunPaths(run_instance_id)
  }

  async createRun(input: CreateRunInput): Promise<StoredRun> {
    if (await this.legacyRunDirExists(input.run_instance_id)) {
      throw new RunnerStoreError('store.run_exists', `Legacy JSON run already exists: ${input.run_instance_id}.`, {
        run_instance_id: input.run_instance_id,
      })
    }

    return this.primary.createRun(input)
  }

  async listRuns(): Promise<RunListItem[]> {
    const primaryRuns = await this.primary.listRuns()
    const seen = new Set(primaryRuns.map((run) => run.run_instance_id))
    const legacyRuns = (await this.legacy_json.listRuns()).filter((run) => !seen.has(run.run_instance_id))
    return [...primaryRuns, ...legacyRuns].sort((left, right) => left.run_instance_id.localeCompare(right.run_instance_id))
  }

  async loadRun(run_instance_id: string): Promise<StoredRun> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.loadRun(run_instance_id)
    }

    return this.legacy_json.loadRun(run_instance_id)
  }

  async writeState(state: RunState): Promise<void> {
    if (await this.primary.hasRun(state.run_instance_id)) {
      await this.primary.writeState(state)
      return
    }

    await this.legacy_json.writeState(state)
  }

  async appendEvent(run_instance_id: string, input: AppendRunnerEventInput): Promise<RunnerEvent> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.appendEvent(run_instance_id, input)
    }

    return this.legacy_json.appendEvent(run_instance_id, input)
  }

  async readEvents(run_instance_id: string, limit?: number): Promise<RunnerEvent[]> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.readEvents(run_instance_id, limit)
    }

    return this.legacy_json.readEvents(run_instance_id, limit)
  }

  async writeStepSnapshot(run_instance_id: string, step: ResolvedStep): Promise<StoreFileRef> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.writeStepSnapshot(run_instance_id, step)
    }

    return this.legacy_json.writeStepSnapshot(run_instance_id, step)
  }

  async writePrompt(run_instance_id: string, input: WritePromptInput): Promise<StoreFileRef> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.writePrompt(run_instance_id, input)
    }

    return this.legacy_json.writePrompt(run_instance_id, input)
  }

  async writeStartReport(run_instance_id: string, input: WriteStartReportInput): Promise<StoreFileRef> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.writeStartReport(run_instance_id, input)
    }

    return this.legacy_json.writeStartReport(run_instance_id, input)
  }

  async writeStatusReport(run_instance_id: string, input: WriteStatusReportInput): Promise<StoreFileRef> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.writeStatusReport(run_instance_id, input)
    }

    return this.legacy_json.writeStatusReport(run_instance_id, input)
  }

  async nextAttemptNumber(run_instance_id: string, step: StepFileReference): Promise<number> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.nextAttemptNumber(run_instance_id, step)
    }

    return this.legacy_json.nextAttemptNumber(run_instance_id, step)
  }

  async inspectRun(run_instance_id: string): Promise<RunInspection> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.inspectRun(run_instance_id)
    }

    return this.legacy_json.inspectRun(run_instance_id)
  }

  async recoverRun(run_instance_id: string, reason?: string): Promise<RecoverRunResult> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.recoverRun(run_instance_id, reason)
    }

    return this.legacy_json.recoverRun(run_instance_id, reason)
  }

  async deleteRun(run_instance_id: string): Promise<DeleteRunResult> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.deleteRun(run_instance_id)
    }

    return this.legacy_json.deleteRun(run_instance_id)
  }

  async listParallelGroups(run_instance_id: string): Promise<ParallelGroupState[]> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.listParallelGroups(run_instance_id)
    }

    return this.legacy_json.listParallelGroups(run_instance_id)
  }

  async getParallelGroup(run_instance_id: string, group_id: string): Promise<ParallelGroupState> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.getParallelGroup(run_instance_id, group_id)
    }

    return this.legacy_json.getParallelGroup(run_instance_id, group_id)
  }

  async recordParallelPreflight(
    run_instance_id: string,
    input: RecordParallelPreflightInput,
  ): Promise<ParallelPreflightResult> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.recordParallelPreflight(run_instance_id, input)
    }

    return this.legacy_json.recordParallelPreflight(run_instance_id, input)
  }

  async grantParallelLeases(
    run_instance_id: string,
    group_id: string,
    input: GrantParallelLeasesInput,
  ): Promise<ParallelLeaseGrantResult> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.grantParallelLeases(run_instance_id, group_id, input)
    }

    return this.legacy_json.grantParallelLeases(run_instance_id, group_id, input)
  }

  async recordParallelHeartbeat(
    run_instance_id: string,
    group_id: string,
    lease_id: string,
    input: RecordParallelHeartbeatInput = {},
  ): Promise<ParallelLeaseState> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.recordParallelHeartbeat(run_instance_id, group_id, lease_id, input)
    }

    return this.legacy_json.recordParallelHeartbeat(run_instance_id, group_id, lease_id, input)
  }

  async recordParallelAttemptResult(
    run_instance_id: string,
    group_id: string,
    input: RecordParallelAttemptResultInput,
  ): Promise<ParallelAttemptResultRecord> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.recordParallelAttemptResult(run_instance_id, group_id, input)
    }

    return this.legacy_json.recordParallelAttemptResult(run_instance_id, group_id, input)
  }

  async retryParallelItem(
    run_instance_id: string,
    group_id: string,
    item_id: string,
    input: RetryParallelItemInput = {},
  ): Promise<RetryParallelItemResult> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.retryParallelItem(run_instance_id, group_id, item_id, input)
    }

    return this.legacy_json.retryParallelItem(run_instance_id, group_id, item_id, input)
  }

  async recoverStaleParallelLeases(
    run_instance_id: string,
    group_id: string,
    input: RecoverStaleParallelLeasesInput = {},
  ): Promise<RecoverStaleParallelLeasesResult> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.recoverStaleParallelLeases(run_instance_id, group_id, input)
    }

    return this.legacy_json.recoverStaleParallelLeases(run_instance_id, group_id, input)
  }

  async controlParallelGroup(
    run_instance_id: string,
    group_id: string,
    action: ParallelGroupControlAction,
    input: ControlParallelGroupInput = {},
  ): Promise<ParallelGroupState> {
    if (await this.primary.hasRun(run_instance_id)) {
      return this.primary.controlParallelGroup(run_instance_id, group_id, action, input)
    }

    return this.legacy_json.controlParallelGroup(run_instance_id, group_id, action, input)
  }

  private async legacyRunDirExists(run_instance_id: string): Promise<boolean> {
    const paths = this.legacy_json.getRunPaths(run_instance_id)
    try {
      const stat = await fs.stat(paths.run_dir)
      return stat.isDirectory()
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return false
      }

      throw error
    }
  }
}
