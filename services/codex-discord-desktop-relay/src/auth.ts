import crypto from 'node:crypto'

function toBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

export function constantTimeSecretEqual(expected: string, provided: string): boolean {
  const expectedBuffer = toBuffer(expected)
  const providedBuffer = toBuffer(provided)
  if (expectedBuffer.length !== providedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

export function readBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}
