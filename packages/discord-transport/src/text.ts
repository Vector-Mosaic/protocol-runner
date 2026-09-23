const MAX_THREAD_NAME_LENGTH = 90
const DEFAULT_MESSAGE_CHUNK_LENGTH = 1900

export function truncateDiscordThreadName(value: string, maxLength = MAX_THREAD_NAME_LENGTH): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return 'relay-thread'
  }

  if (compact.length <= maxLength) {
    return compact
  }

  return `${compact.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`
}

export function createStableDiscordThreadName(
  value: string,
  stableSuffix: string | null,
  maxLength = MAX_THREAD_NAME_LENGTH,
): string {
  const compactSuffix = stableSuffix?.replace(/\s+/g, ' ').trim() || ''
  const suffix = compactSuffix ? ` [${compactSuffix}]` : ''
  const compactValue = value.replace(/\s+/g, ' ').trim() || 'relay-thread'
  if (!suffix) {
    return truncateDiscordThreadName(compactValue, maxLength)
  }

  if (compactValue.length + suffix.length <= maxLength) {
    return `${compactValue}${suffix}`
  }

  const baseLength = Math.max(1, maxLength - suffix.length - 3)
  return `${compactValue.slice(0, baseLength).trimEnd()}...${suffix}`
}

export function splitDiscordMessageText(value: string, maxLength = DEFAULT_MESSAGE_CHUNK_LENGTH): string[] {
  const trimmed = value.trim()
  if (!trimmed) {
    return ['(empty)']
  }

  if (trimmed.length <= maxLength) {
    return [trimmed]
  }

  const chunks: string[] = []
  let remaining = trimmed
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength)
    const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '))
    const end = splitAt >= Math.floor(maxLength * 0.4) ? splitAt : maxLength
    chunks.push(remaining.slice(0, end).trim())
    remaining = remaining.slice(end).trim()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}
