import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const action = process.argv[2] ?? 'all'
if (!['build', 'test', 'lint', 'all'].includes(action)) throw new Error('Expected build, test, lint or all')
const packages = ['packages', 'services', 'apps'].flatMap((group) =>
  readdirSync(path.join(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, group, entry.name, 'package.json')))
    .map((entry) => ({ dir: path.join(group, entry.name), ...JSON.parse(readFileSync(path.join(root, group, entry.name, 'package.json'), 'utf8')) })))

// The real dependency graph determines order; each component is visited once.
const ordered = []
const visiting = new Set()
const visited = new Set()
function visit(pkg) {
  if (visited.has(pkg.name)) return
  if (visiting.has(pkg.name)) throw new Error(`Workspace dependency cycle: ${pkg.name}`)
  visiting.add(pkg.name)
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const dep = packages.find((candidate) => candidate.name === name)
    if (dep) visit(dep)
  }
  visiting.delete(pkg.name)
  visited.add(pkg.name)
  ordered.push(pkg)
}
packages.forEach(visit)
const stages = action === 'all' ? ['build', 'test', 'lint'] : [action]
for (const stage of stages) {
  for (const pkg of ordered) {
    if (!pkg.scripts?.[stage]) continue
    console.log(`\n${stage}: ${pkg.name}`)
    const npmExec = process.env.npm_execpath
    if (!npmExec) throw new Error('Run through pnpm: pnpm ' + action)
    const child = spawnSync(process.execPath, [npmExec, '--dir', path.join(root, pkg.dir), 'run', stage], { stdio: 'inherit', env: process.env })
    if (child.error) throw child.error
    if (child.status !== 0) process.exit(child.status ?? 1)
  }
}
