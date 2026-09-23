import crypto from 'node:crypto'

import { splitDiscordMessageText } from '@workstation-control/discord-transport'

import type { PublishRequest, PublishResult } from './types.js'

export interface DiscordPublisherTransport {
  createMessage(channelId: string, content: string): Promise<{ messageId: string }>
}

export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export class DiscordPublisher {
  constructor(private readonly transport: DiscordPublisherTransport) {}

  async publish(request: PublishRequest): Promise<PublishResult> {
    const chunks = splitDiscordMessageText(request.text)
    const messageIds: string[] = []

    for (const [index, chunk] of chunks.entries()) {
      const content = chunks.length === 1 ? chunk : `(${index + 1}/${chunks.length})\n${chunk}`
      const message = await this.transport.createMessage(request.channelId, content)
      messageIds.push(message.messageId)
    }

    return {
      ok: true,
      channelId: request.channelId,
      messageIds,
      chunkCount: chunks.length,
      textSha256: sha256Text(request.text),
    }
  }
}
