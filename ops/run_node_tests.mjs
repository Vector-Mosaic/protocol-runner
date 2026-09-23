import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TOOL_ID = 'tool.system.workstation_control.run_node_tests'
const ENTRYPOINT = 'node ops/run_node_tests.mjs'
const USAGE_PAYLOAD = {
  schema_version: 'tool_usage.v1',
  tool_id: TOOL_ID,
  purpose: 'Run compiled Workstation Control Node test files with node --test.',
  entrypoint: ENTRYPOINT,
  safe_first_calls: [
    { label: 'usage', cmd: ENTRYPOINT },
    { label: 'usage-json', cmd: `${ENTRYPOINT} usage --format json` },
    { label: 'help', cmd: `${ENTRYPOINT} run --help` },
  ],
  verbs: [
    { name: 'usage', side_effects: 'none', summary: 'Return this compact usage contract.' },
    { name: 'run', side_effects: 'spawns node --test against compiled test files', summary: 'Run tests under the selected compiled output directory.' },
  ],
  examples: [
    { label: 'Run default dist tests', cmd: `${ENTRYPOINT} run` },
    { label: 'Run selected compiled test root', cmd: `${ENTRYPOINT} run dist/test` },
  ],
  side_effects: {
    writes_repo: false,
    writes_external_paths: [],
    network_access: 'none',
    danger_level: 'low',
    supports_dry_run: false,
  },
  docs: 'docs/evidence.md',
}

function usageFormat(args) {
  let outputFormat = 'text'
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      outputFormat = 'json'
    } else if (arg === '--format' && index + 1 < args.length) {
      outputFormat = args[index + 1]
      index += 1
    } else if (arg.startsWith('--format=')) {
      outputFormat = arg.slice('--format='.length)
    }
  }
  return outputFormat === 'json' ? 'json' : 'text'
}

function emitUsage(args) {
  if (usageFormat(args) === 'json') {
    console.log(JSON.stringify(USAGE_PAYLOAD, null, 2))
    return
  }
  console.log(`${USAGE_PAYLOAD.purpose}\n`)
  console.log(`entrypoint: ${USAGE_PAYLOAD.entrypoint}\n`)
  console.log('safe first calls:')
  for (const item of USAGE_PAYLOAD.safe_first_calls) {
    console.log(`  ${item.label}: ${item.cmd}`)
  }
  console.log('\nverbs:')
  for (const item of USAGE_PAYLOAD.verbs) {
    console.log(`  ${item.name}: ${item.summary} [${item.side_effects}]`)
  }
  console.log('\nexamples:')
  for (const item of USAGE_PAYLOAD.examples) {
    console.log(`  ${item.label}: ${item.cmd}`)
  }
  console.log('\nside effects:')
  for (const [key, value] of Object.entries(USAGE_PAYLOAD.side_effects)) {
    console.log(`  ${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  console.log(`\ndocs: ${USAGE_PAYLOAD.docs}`)
}

function isUsageRequest(args) {
  return args.length === 0 || args[0] === 'usage'
}

function normalizeRunArgs(args) {
  if (args[0] === 'run') {
    return args.slice(1)
  }
  return args
}

function emitHelp() {
  console.log(`usage: ${ENTRYPOINT} run [test-root]`)
  console.log('')
  console.log('Runs compiled .test/.spec JavaScript files below test-root with node --test.')
  console.log('Defaults to test-root=dist.')
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(entryPath))
      continue
    }

    out.push(entryPath)
  }

  return out
}

function main() {
  const rawArgs = process.argv.slice(2)
  if (isUsageRequest(rawArgs)) {
    emitUsage(rawArgs)
    return
  }

  const args = normalizeRunArgs(rawArgs)
  if (args[0] === '--help' || args[0] === '-h') {
    emitHelp()
    return
  }

  const rel = args[0] ?? 'dist'
  const root = path.resolve(process.cwd(), rel)

  if (!fs.existsSync(root)) {
    console.error(`[run_node_tests] missing test root: ${root}`)
    process.exit(1)
  }

  const files = walk(root).filter((filePath) => /\.(test|spec)\.[cm]?js$/i.test(filePath))
  if (files.length === 0) {
    console.error(`[run_node_tests] no test files found under: ${root}`)
    process.exit(1)
  }

  const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
  })

  process.exit(typeof result.status === 'number' ? result.status : 1)
}

main()
