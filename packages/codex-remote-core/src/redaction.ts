const SENSITIVE_KEYS = new Set([
  'authorization',
  'content',
  'cookie',
  'cookies',
  'csrfToken',
  'prompt',
  'secret',
  'session',
  'text',
  'token',
  'transcript',
])

function redactString(value: string): string {
  return `[REDACTED:${value.length}]`
}

export function redactForLog(value: unknown, parentKey?: string): unknown {
  if (typeof value === 'string') {
    return parentKey && SENSITIVE_KEYS.has(parentKey) ? redactString(value) : value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactForLog(entry, parentKey))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (SENSITIVE_KEYS.has(key)) {
      if (typeof entry === 'string') {
        result[key] = redactString(entry)
      } else if (Array.isArray(entry)) {
        result[key] = `[REDACTED:${entry.length}]`
      } else if (entry && typeof entry === 'object') {
        result[key] = '[REDACTED]'
      } else {
        result[key] = entry
      }
      continue
    }

    result[key] = redactForLog(entry, key)
  }

  return result
}
