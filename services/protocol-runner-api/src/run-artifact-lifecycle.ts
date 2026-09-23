import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const TRANSACTION_SCHEMA_VERSION = 'protocol_runner.run_artifact_transaction.v1'

export type RunArtifactTransactionKind = 'create' | 'retire'

export interface RunArtifactTransaction {
  kind: RunArtifactTransactionKind
  transaction_id: string
  run_instance_id: string
  transaction_dir: string
  staged_run_dir: string
  final_run_dir: string
}

export interface RunArtifactReconciliationReport {
  transactions_found: number
  create_finalized: number
  create_abandoned: number
  retire_restored: number
  retire_finished: number
}

interface RunArtifactTransactionMarker {
  schema_version: typeof TRANSACTION_SCHEMA_VERSION
  kind: RunArtifactTransactionKind
  transaction_id: string
  run_instance_id: string
  created_at: string
}

export interface RunArtifactLifecycleOptions {
  runs_root: string
  now?: () => Date
  transaction_id_factory?: () => string
}

export class RunLifecycleCoordinator {
  private queue: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.queue.catch(() => undefined)
    const current = prior.then(operation)
    this.queue = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }
}

export class RunArtifactLifecycle {
  readonly runs_root: string
  readonly transaction_root: string
  private readonly now: () => Date
  private readonly transaction_id_factory: () => string

  constructor(options: RunArtifactLifecycleOptions) {
    this.runs_root = path.resolve(options.runs_root)
    this.transaction_root = path.join(this.runs_root, '.transactions')
    this.now = options.now ?? (() => new Date())
    this.transaction_id_factory = options.transaction_id_factory ?? (() => randomUUID())
  }

  async beginCreate(run_instance_id: string): Promise<RunArtifactTransaction> {
    const transaction = await this.createTransaction('create', run_instance_id)
    await fs.mkdir(transaction.staged_run_dir)
    return transaction
  }

  async commitCreate(transaction: RunArtifactTransaction): Promise<void> {
    this.requireKind(transaction, 'create')
    if (await pathExists(transaction.final_run_dir)) {
      throw new Error(`Cannot promote staged run because the final run directory exists: ${transaction.final_run_dir}`)
    }
    await fs.rename(transaction.staged_run_dir, transaction.final_run_dir)
    await this.removeTransactionDir(transaction.transaction_dir)
  }

  async rollbackCreate(transaction: RunArtifactTransaction, remove_final: boolean): Promise<void> {
    this.requireKind(transaction, 'create')
    if (remove_final && (await pathExists(transaction.final_run_dir))) {
      await fs.rm(transaction.final_run_dir, { recursive: true, force: false })
    }
    if (await pathExists(transaction.transaction_dir)) {
      await this.removeTransactionDir(transaction.transaction_dir)
    }
  }

  async beginRetire(run_instance_id: string): Promise<RunArtifactTransaction> {
    const transaction = await this.createTransaction('retire', run_instance_id)
    try {
      await fs.rename(transaction.final_run_dir, transaction.staged_run_dir)
      return transaction
    } catch (error) {
      await this.removeTransactionDir(transaction.transaction_dir)
      throw error
    }
  }

  async commitRetire(transaction: RunArtifactTransaction): Promise<void> {
    this.requireKind(transaction, 'retire')
    await this.removeTransactionDir(transaction.transaction_dir)
  }

  async rollbackRetire(transaction: RunArtifactTransaction): Promise<void> {
    this.requireKind(transaction, 'retire')
    const finalExists = await pathExists(transaction.final_run_dir)
    const stagedExists = await pathExists(transaction.staged_run_dir)
    if (finalExists && stagedExists) {
      throw new Error(`Cannot restore retired run because both run directories exist: ${transaction.run_instance_id}`)
    }
    if (!finalExists && stagedExists) {
      await fs.rename(transaction.staged_run_dir, transaction.final_run_dir)
    }
    await this.removeTransactionDir(transaction.transaction_dir)
  }

  async reconcile(hasCommittedRun: (run_instance_id: string) => boolean | Promise<boolean>): Promise<RunArtifactReconciliationReport> {
    const report: RunArtifactReconciliationReport = {
      transactions_found: 0,
      create_finalized: 0,
      create_abandoned: 0,
      retire_restored: 0,
      retire_finished: 0,
    }
    const entries = await readDirEntriesIfExists(this.transaction_root)
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw new Error(`Unexpected non-directory entry in Protocol Runner transaction root: ${entry.name}`)
      }
      report.transactions_found += 1
      const transaction = await this.readTransaction(path.join(this.transaction_root, entry.name))
      const committed = await hasCommittedRun(transaction.run_instance_id)
      const finalExists = await pathExists(transaction.final_run_dir)
      const stagedExists = await pathExists(transaction.staged_run_dir)

      if (transaction.kind === 'create') {
        if (committed) {
          if (finalExists && stagedExists) {
            throw new Error(`Ambiguous create recovery for ${transaction.run_instance_id}: final and staged runs both exist.`)
          }
          if (!finalExists && !stagedExists) {
            throw new Error(`Cannot recover committed run ${transaction.run_instance_id}: no final or staged run directory exists.`)
          }
          if (!finalExists && stagedExists) {
            await fs.rename(transaction.staged_run_dir, transaction.final_run_dir)
            report.create_finalized += 1
          }
        } else {
          report.create_abandoned += 1
        }
        await this.removeTransactionDir(transaction.transaction_dir)
        continue
      }

      if (committed) {
        if (finalExists && stagedExists) {
          throw new Error(`Ambiguous retire recovery for ${transaction.run_instance_id}: final and retired runs both exist.`)
        }
        if (!finalExists && !stagedExists) {
          throw new Error(`Cannot restore committed run ${transaction.run_instance_id}: no final or retired run directory exists.`)
        }
        if (!finalExists && stagedExists) {
          await fs.rename(transaction.staged_run_dir, transaction.final_run_dir)
          report.retire_restored += 1
        }
      } else {
        report.retire_finished += 1
      }
      await this.removeTransactionDir(transaction.transaction_dir)
    }
    return report
  }

  private async createTransaction(
    kind: RunArtifactTransactionKind,
    run_instance_id: string,
  ): Promise<RunArtifactTransaction> {
    await fs.mkdir(this.transaction_root, { recursive: true })
    const transaction_id = this.transaction_id_factory()
    const transaction_dir = path.join(this.transaction_root, `${kind}.${run_instance_id}.${transaction_id}`)
    this.assertInsideRoot(transaction_dir)
    await fs.mkdir(transaction_dir, { recursive: false })
    const transaction: RunArtifactTransaction = {
      kind,
      transaction_id,
      run_instance_id,
      transaction_dir,
      staged_run_dir: path.join(transaction_dir, 'run'),
      final_run_dir: path.join(this.runs_root, run_instance_id),
    }
    const marker: RunArtifactTransactionMarker = {
      schema_version: TRANSACTION_SCHEMA_VERSION,
      kind,
      transaction_id,
      run_instance_id,
      created_at: this.now().toISOString(),
    }
    await fs.writeFile(path.join(transaction_dir, 'transaction.json'), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return transaction
  }

  private async readTransaction(transaction_dir: string): Promise<RunArtifactTransaction> {
    this.assertInsideRoot(transaction_dir)
    const markerPath = path.join(transaction_dir, 'transaction.json')
    const raw = await fs.readFile(markerPath, 'utf8')
    const marker = JSON.parse(raw) as Partial<RunArtifactTransactionMarker>
    if (
      marker.schema_version !== TRANSACTION_SCHEMA_VERSION ||
      (marker.kind !== 'create' && marker.kind !== 'retire') ||
      typeof marker.transaction_id !== 'string' ||
      typeof marker.run_instance_id !== 'string'
    ) {
      throw new Error(`Invalid Protocol Runner artifact transaction marker: ${markerPath}`)
    }
    const expectedName = `${marker.kind}.${marker.run_instance_id}.${marker.transaction_id}`
    if (path.basename(transaction_dir) !== expectedName) {
      throw new Error(`Protocol Runner artifact transaction directory does not match its marker: ${transaction_dir}`)
    }
    return {
      kind: marker.kind,
      transaction_id: marker.transaction_id,
      run_instance_id: marker.run_instance_id,
      transaction_dir,
      staged_run_dir: path.join(transaction_dir, 'run'),
      final_run_dir: path.join(this.runs_root, marker.run_instance_id),
    }
  }

  private requireKind(transaction: RunArtifactTransaction, expected: RunArtifactTransactionKind): void {
    if (transaction.kind !== expected) {
      throw new Error(`Expected ${expected} artifact transaction, received ${transaction.kind}.`)
    }
  }

  private async removeTransactionDir(transaction_dir: string): Promise<void> {
    this.assertInsideRoot(transaction_dir)
    await fs.rm(transaction_dir, { recursive: true, force: false })
  }

  private assertInsideRoot(candidate: string): void {
    const relative = path.relative(this.transaction_root, path.resolve(candidate))
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Artifact transaction path escapes its owned transaction root: ${candidate}`)
    }
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
    throw error
  }
}

async function readDirEntriesIfExists(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}
