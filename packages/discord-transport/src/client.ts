import fs from 'node:fs/promises'
import path from 'node:path'

export interface DiscordBotClientConfig {
  apiBaseUrl: string
  botToken: string
  guildId: string | null
}

export interface DiscordCreateMessageAttachment {
  localPath: string
  fileName: string
  contentType: string | null
}

export interface DiscordThreadReference {
  guildId: string | null
  channelId: string
  threadId: string
  rootMessageId: string
  threadUrl: string | null
}

export interface DiscordThreadMessageAttachment {
  id: string
  fileName: string
  contentType: string | null
  sizeBytes: number | null
  url: string
}

export interface DiscordThreadMessage {
  messageId: string
  authorId: string | null
  authorDisplay: string | null
  authorIsBot: boolean
  content: string
  createdAt: string
  attachments: DiscordThreadMessageAttachment[]
}

interface DiscordSelfUser {
  id: string
}

interface DiscordCreatedMessage {
  id: string
}

interface DiscordCreatedThread {
  id: string
}

interface DiscordCreatedChannel {
  id: string
  name?: string | null
}

interface DiscordUpdatedChannel {
  id: string
  name?: string | null
}

interface DiscordListedMessage {
  id: string
  content?: string | null
  timestamp?: string | null
  author?: {
    id?: string | null
    username?: string | null
    global_name?: string | null
    bot?: boolean | null
  } | null
  attachments?: Array<{
    id?: string | null
    filename?: string | null
    content_type?: string | null
    size?: number | null
    url?: string | null
  }> | null
}

function buildThreadUrl(guildId: string | null, threadId: string): string | null {
  return guildId ? `https://discord.com/channels/${guildId}/${threadId}` : null
}

export class DiscordBotClient {
  private selfUserId: string | null = null

  constructor(private readonly config: DiscordBotClientConfig) {}

  async initialize(): Promise<void> {
    const user = await this.requestJson<DiscordSelfUser>('/users/@me')
    this.selfUserId = user.id
  }

  async createMessage(
    channelId: string,
    content: string,
    attachments: DiscordCreateMessageAttachment[] = [],
  ): Promise<{ messageId: string }> {
    if (attachments.length === 0) {
      const message = await this.requestJson<DiscordCreatedMessage>(`/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      })
      return { messageId: message.id }
    }

    const form = new FormData()
    const mappedAttachments = await Promise.all(
      attachments.map(async (attachment, index) => {
        const buffer = await fs.readFile(attachment.localPath)
        form.set(
          `files[${index}]`,
          new Blob([buffer], { type: attachment.contentType ?? undefined }),
          attachment.fileName,
        )
        return {
          id: index,
          filename: attachment.fileName,
        }
      }),
    )
    form.set(
      'payload_json',
      JSON.stringify({
        content,
        attachments: mappedAttachments,
      }),
    )
    const message = await this.requestJson<DiscordCreatedMessage>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: form,
    })
    return { messageId: message.id }
  }

  async createThread(
    channelId: string,
    rootMessageId: string,
    name: string,
    autoArchiveDurationMinutes: number,
  ): Promise<DiscordThreadReference> {
    const thread = await this.requestJson<DiscordCreatedThread>(`/channels/${channelId}/messages/${rootMessageId}/threads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        auto_archive_duration: autoArchiveDurationMinutes,
      }),
    })

    return {
      guildId: this.config.guildId,
      channelId,
      threadId: thread.id,
      rootMessageId,
      threadUrl: buildThreadUrl(this.config.guildId, thread.id),
    }
  }

  async createTextChannel(name: string, parentChannelId: string | null = null): Promise<{
    guildId: string
    channelId: string
    name: string
    channelUrl: string | null
  }> {
    if (!this.config.guildId) {
      throw new Error('Discord guild id is required to create a text channel.')
    }

    const body: Record<string, unknown> = {
      name,
      type: 0,
    }
    if (parentChannelId) {
      body.parent_id = parentChannelId
    }

    const channel = await this.requestJson<DiscordCreatedChannel>(`/guilds/${this.config.guildId}/channels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return {
      guildId: this.config.guildId,
      channelId: channel.id,
      name: channel.name ?? name,
      channelUrl: `https://discord.com/channels/${this.config.guildId}/${channel.id}`,
    }
  }

  async updateTextChannelName(channelId: string, name: string): Promise<{ channelId: string; name: string }> {
    const channel = await this.requestJson<DiscordUpdatedChannel>(`/channels/${channelId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    })

    return {
      channelId: channel.id,
      name: channel.name ?? name,
    }
  }

  async deleteTextChannel(channelId: string): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}/channels/${channelId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
      },
    })
    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Discord API /channels/${channelId} failed: HTTP ${response.status} ${responseText}`)
    }
  }

  async listMessages(channelId: string, afterMessageId: string | null): Promise<DiscordThreadMessage[]> {
    const suffix = afterMessageId ? `?after=${encodeURIComponent(afterMessageId)}&limit=50` : '?limit=50'
    const rawMessages = await this.requestJson<DiscordListedMessage[]>(`/channels/${channelId}/messages${suffix}`)
    return rawMessages
      .map((message) => ({
        messageId: message.id,
        authorId: message.author?.id ?? null,
        authorDisplay: message.author?.global_name ?? message.author?.username ?? null,
        authorIsBot: Boolean(message.author?.bot) || message.author?.id === this.selfUserId,
        content: message.content ?? '',
        createdAt: message.timestamp ?? new Date().toISOString(),
        attachments:
          message.attachments?.flatMap((attachment) => {
            if (!attachment.id || !attachment.filename || !attachment.url) {
              return []
            }
            return [
              {
                id: attachment.id,
                fileName: attachment.filename,
                contentType: attachment.content_type ?? null,
                sizeBytes: attachment.size ?? null,
                url: attachment.url,
              },
            ]
          }) ?? [],
      }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async downloadAttachment(attachment: DiscordThreadMessageAttachment, destinationPath: string): Promise<void> {
    const response = await fetch(attachment.url)
    if (!response.ok) {
      throw new Error(`Unable to download Discord attachment ${attachment.id}: HTTP ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    await fs.writeFile(destinationPath, buffer)
  }

  private async requestJson<T>(relativePath: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.apiBaseUrl}${relativePath}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Discord API ${relativePath} failed: HTTP ${response.status} ${responseText}`)
    }
    return (await response.json()) as T
  }
}
