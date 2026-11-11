import { timingSafeEqual } from 'node:crypto'
import {
  extractCard,
  extractFiles,
  extractPostableAttachments,
  ValidationError,
} from '@chat-adapter/shared'
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  NotImplementedError,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
  type WebhookOptions,
} from 'chat'
import { z } from 'zod'
import { ZappazClient } from './client.ts'
import { ZappazFormatConverter } from './format-converter.ts'
import {
  ConfigSchema,
  ConversationSchema,
  IncomingMessageSchema,
  MessageSchema,
  PageSchema,
  WebhookSchema,
  type ZappazAdapterConfig,
  type ZappazMessage,
  type ZappazThreadId,
} from './types.ts'

const ThreadSchema = z.object({ sessionId: z.string().min(1), conversationId: z.uuid() })

export class ZappazAdapter implements Adapter<ZappazThreadId, ZappazMessage> {
  readonly name = 'zappaz'
  readonly userName: string
  private chat: ChatInstance | undefined
  private readonly client: ZappazClient
  private readonly converter = new ZappazFormatConverter()
  private readonly config: ZappazAdapterConfig

  constructor(config: ZappazAdapterConfig) {
    const parsed = ConfigSchema.safeParse(config)
    if (!parsed.success)
      throw new ValidationError(
        'zappaz',
        'Invalid adapter config: provide an HTTP(S) origin, API key, session ID and webhook secret of at least 16 characters',
      )
    this.config = parsed.data
    this.userName = this.config.userName ?? 'zappaz-bot'
    this.client = new ZappazClient(this.config)
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat
  }

  encodeThreadId(data: ZappazThreadId): string {
    const parsed = ThreadSchema.safeParse(data)
    if (!parsed.success || data.sessionId !== this.config.sessionId)
      throw new ValidationError('zappaz', 'Invalid thread scope')
    return `zappaz:${Buffer.from(data.sessionId).toString('base64url')}:${data.conversationId}`
  }

  decodeThreadId(threadId: string): ZappazThreadId {
    const [name, session, conversationId, extra] = threadId.split(':')
    const parsed = ThreadSchema.safeParse({
      sessionId: session ? Buffer.from(session, 'base64url').toString() : '',
      conversationId,
    })
    if (
      name !== this.name ||
      extra !== undefined ||
      !parsed.success ||
      parsed.data.sessionId !== this.config.sessionId ||
      this.encodeThreadId(parsed.data) !== threadId
    )
      throw new ValidationError('zappaz', 'Invalid thread ID or session')
    return parsed.data
  }

  channelIdFromThreadId(threadId: string): string {
    this.decodeThreadId(threadId)
    return threadId
  }

  isDM(threadId: string): boolean {
    this.decodeThreadId(threadId)
    return true
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    const received = Buffer.from(token ?? '')
    const expected = Buffer.from(this.config.webhookSecret)
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return new Response('Unauthorized', { status: 401 })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }
    const event = WebhookSchema.safeParse(body)
    if (!event.success) return new Response('Invalid webhook', { status: 400 })
    if (event.data.session.id !== this.config.sessionId)
      return new Response('Wrong session', { status: 403 })
    if (event.data.event !== 'inbound-message.upsert')
      return new Response('Ignored', { status: 200 })
    const payload = IncomingMessageSchema.safeParse(event.data.payload)
    if (!payload.success) return new Response('Invalid message', { status: 400 })
    const incoming = payload.data.message
    if (incoming.fromMe || incoming.isGroup || incoming.type !== 'text')
      return new Response('Ignored', { status: 200 })
    if (!this.chat) return new Response('Adapter not initialized', { status: 503 })
    try {
      const identifiers = [incoming.remoteJid, incoming.lid, incoming.chatId]
        .filter((id): id is string => id !== null)
        .map((id) => id.replace(/:\d+(?=@)/, ''))
      const conversationId = await this.client.conversationFor(identifiers)
      const message = await this.client.messageFor(conversationId, incoming.id)
      if (message.fromMe || message.deletedAt || message.type !== 'text')
        return new Response('Ignored', { status: 200 })
      const parsed = this.parseMessage(message)
      // Chat SDK owns background dispatch and registers it with waitUntil.
      void this.chat.processMessage(this, parsed.threadId, parsed, options).catch(() => {
        this.chat?.getLogger('zappaz').error('Zappaz message dispatch failed')
      })
      return new Response('OK')
    } catch {
      this.chat.getLogger('zappaz').error('Unable to resolve persisted Zappaz message')
      return new Response('Zappaz unavailable', { status: 503 })
    }
  }

  parseMessage(raw: ZappazMessage): Message<ZappazMessage> {
    const message = MessageSchema.parse(raw)
    return new Message({
      id: message.id,
      threadId: this.encodeThreadId(message),
      ...this.converter.parseIncoming(
        message.deletedAt ? '[Mensagem apagada]' : (message.text ?? `[${message.type}]`),
      ),
      raw: message,
      author: {
        fullName: message.sender.name ?? '',
        userId:
          message.sender.jid ??
          (message.fromMe
            ? `session:${message.sessionId}`
            : `conversation:${message.conversationId}`),
        userName: message.sender.name ?? message.sender.jid ?? 'WhatsApp',
        isBot: 'unknown',
        isMe: false,
      },
      metadata: {
        dateSent: new Date(message.orderAt),
        edited: message.editedAt !== null,
        ...(message.editedAt ? { editedAt: new Date(message.editedAt) } : {}),
      },
      attachments: [],
    })
  }

  private path(threadId: string): string {
    return `/conversations/${this.decodeThreadId(threadId).conversationId}`
  }

  private text(message: AdapterPostableMessage): string {
    if (
      extractCard(message) ||
      extractFiles(message).length ||
      extractPostableAttachments(message).length
    )
      throw new NotImplementedError('Zappaz adapter supports text only')
    const text = this.converter.renderPostable(message)
    if (!text.trim() || text.length > 4096)
      throw new ValidationError('zappaz', 'Text must contain 1–4096 characters')
    return text
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZappazMessage>> {
    const result = await this.client.request(
      `${this.path(threadId)}/messages/text`,
      z.object({ data: MessageSchema }),
      'POST',
      { text: this.text(message), clientRequestId: crypto.randomUUID(), signMessage: false },
    )
    return { id: result.data.id, raw: result.data, threadId }
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZappazMessage>> {
    const result = await this.client.request(
      `${this.path(threadId)}/messages/${z.uuid().parse(messageId)}`,
      z.object({ data: MessageSchema }),
      'PATCH',
      { text: this.text(message) },
    )
    return { id: result.data.id, raw: result.data, threadId }
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    await this.client.request(
      `${this.path(threadId)}/messages/${z.uuid().parse(messageId)}`,
      z.object({ data: MessageSchema }),
      'DELETE',
    )
  }

  async fetchMessages(
    threadId: string,
    options: FetchOptions = {},
  ): Promise<FetchResult<ZappazMessage>> {
    if (options.direction === 'forward')
      throw new NotImplementedError('Zappaz adapter supports backward history pagination only')
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options.limit ?? 50)
    const params = new URLSearchParams({
      limit: String(limit),
      ...(options.cursor ? { before: options.cursor } : {}),
    })
    const result = await this.client.request(
      `${this.path(threadId)}/messages?${params}`,
      z.object({ data: z.array(MessageSchema), page: PageSchema }),
    )
    return {
      messages: result.data.map((message) => this.parseMessage(message)),
      nextCursor: result.page.hasMore ? (result.page.nextCursor ?? undefined) : undefined,
    }
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const result = await this.client.request(
      this.path(threadId),
      z.object({ data: ConversationSchema }),
    )
    return {
      id: threadId,
      channelId: threadId,
      channelName: result.data.displayName,
      isDM: true,
      metadata: { sessionId: result.data.sessionId, conversationId: result.data.id },
    }
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content)
  }

  async stream(
    threadId: string,
    chunks: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<RawMessage<ZappazMessage>> {
    let text = ''
    for await (const chunk of chunks) {
      options?.signal?.throwIfAborted()
      if (typeof chunk === 'string') text += chunk
      else if (chunk.type === 'markdown_text') text += chunk.text
      if (text.length > 65_536) throw new ValidationError('zappaz', 'Stream exceeds text budget')
    }
    options?.signal?.throwIfAborted()
    return this.postMessage(threadId, { markdown: text })
  }

  async startTyping(_threadId: string): Promise<void> {
    throw new NotImplementedError('Typing is not supported by the Zappaz API')
  }
  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError('Reactions are not supported by this adapter')
  }
  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError('Reactions are not supported by this adapter')
  }
}
