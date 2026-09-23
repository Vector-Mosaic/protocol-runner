function normalizeSeparators(value: string): string {
  return value.replace(/\//g, '\\')
}

export function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  let normalized = normalizeSeparators(value.trim())
  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4)
  }

  normalized = normalized.replace(/\\+$/, '')
  if (normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized[0].toUpperCase() + normalized.slice(1)
  }

  return normalized
}

export function toComparableWorkspacePath(value: string | null | undefined): string | null {
  const normalized = normalizeWorkspacePath(value)
  return normalized ? normalized.toLowerCase() : null
}

export function matchesWorkspaceRoot(candidate: string | null | undefined, workspaceRoot: string): boolean {
  const candidatePath = toComparableWorkspacePath(candidate)
  const expected = toComparableWorkspacePath(workspaceRoot)
  return candidatePath !== null && expected !== null && candidatePath === expected
}

export function fromUnixSeconds(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return new Date(value * 1000).toISOString()
}
