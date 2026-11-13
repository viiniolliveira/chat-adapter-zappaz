import { timingSafeEqual } from 'node:crypto'
import {
  extractCard,
  extractFiles,
  extractPostableAttachments,
  PermissionError,
  ValidationError,
} from '@chat-adapter/shared'
import {
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FileUpload,
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
import { prepareFile, splitText } from './delivery.ts'
import { ZappazFormatConverter } from './format-converter.ts'
import { MessageBuffer } from './message-buffer.ts'
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
const inboundTypes = new Set(['text', 'image', 'audio', 'video', 'document', 'sticker'])
const attachmentTypes: Record<string, Attachment['type']> = {
  image: 'image',
  sticker: 'image',
  audio: 'audio',
  video: 'video',
  document: 'file',
}

export class ZappazAdapter implements Adapter<ZappazThreadId, ZappazMessage> {
  readonly name = 'zappaz'
  readonly userName: string
  private chat: ChatInstance | undefined
  private readonly client: ZappazClient
  private readonly converter = new ZappazFormatConverter()
  private readonly config: ZappazAdapterConfig
  private readonly buffer: MessageBuffer | undefined

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
    if (this.config.debounceMs)
      this.buffer = new MessageBuffer(
        this.config.debounceMs,
        async (messages) => {
          const last = messages.at(-1)
          if (!last || !this.chat || (await this.isThreadPaused(last.threadId))) return
          const combined = new Message({
            ...last,
            ...this.converter.parseIncoming(
              messages.map((message) => message.raw.text ?? `[${message.raw.type}]`).join('\n\n'),
            ),
            attachments: messages.flatMap((message) => message.attachments),
          })
          await this.chat.processMessage(this, last.threadId, combined)
        },
        () => this.chat?.getLogger('zappaz').error('Zappaz batched dispatch failed'),
      )
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat
  }

  async disconnect(): Promise<void> {
    await this.buffer?.disconnect()
    this.chat = undefined
  }

  private state() {
    if (!this.chat) throw new ValidationError('zappaz', 'Adapter not initialized')
    return this.chat.getState()
  }

  async pauseThread(
    threadId: string,
    durationMs = this.config.humanPauseMs || 300_000,
  ): Promise<void> {
    this.decodeThreadId(threadId)
    z.number().int().min(1).max(2_147_483_647).parse(durationMs)
    const existing = await this.state().get<number>(`zappaz:paused:${threadId}`)
    const until = Math.max(typeof existing === 'number' ? existing : 0, Date.now() + durationMs)
    await this.state().set(`zappaz:paused:${threadId}`, until, until - Date.now())
    this.buffer?.cancel(threadId)
    await this.chat?.abortTurn(threadId)
  }

  async resumeThread(threadId: string): Promise<void> {
    this.decodeThreadId(threadId)
    await this.state().delete(`zappaz:paused:${threadId}`)
  }

  async isThreadPaused(threadId: string): Promise<boolean> {
    this.decodeThreadId(threadId)
    if (!this.chat) return false
    const until = await this.state().get<number>(`zappaz:paused:${threadId}`)
    return typeof until === 'number' && until > Date.now()
  }

  private async ensureCanSend(threadId: string): Promise<void> {
    this.decodeThreadId(threadId)
    if (await this.isThreadPaused(threadId))
      throw new PermissionError('zappaz', 'send while human handling is active')
  }

  private async requestId(threadId: string): Promise<string> {
    const id = crypto.randomUUID()
    if (this.config.humanPauseMs)
      await this.state().set(
        `zappaz:sent:${threadId}:${id}`,
        true,
        Math.max(86_400_000, this.config.humanPauseMs),
      )
    return id
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
    const received = Buffer.from(request.headers.get('x-zappaz-webhook-secret') ?? '')
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
    const outgoing =
      event.data.event === 'outbound-message.upsert' || event.data.event === 'messages.send'
    if (event.data.event !== 'inbound-message.upsert' && !(outgoing && this.config.humanPauseMs))
      return new Response('Ignored', { status: 200 })
    const payload = IncomingMessageSchema.safeParse(event.data.payload)
    if (!payload.success) return new Response('Invalid message', { status: 400 })
    const incoming = payload.data.message
    if (
      (!outgoing && incoming.fromMe) ||
      incoming.isGroup ||
      (!outgoing && !inboundTypes.has(incoming.type)) ||
      incoming.id === null ||
      incoming.conversationId === null
    )
      return new Response('Ignored', { status: 200 })
    if (!this.chat) return new Response('Adapter not initialized', { status: 503 })
    try {
      const message = await this.client.messageFor(incoming.conversationId, incoming.id)
      if (
        message.sessionId !== this.config.sessionId ||
        message.conversationId !== incoming.conversationId ||
        message.id !== incoming.id ||
        (incoming.messageId !== null && message.messageId !== incoming.messageId)
      )
        throw new ValidationError('zappaz', 'Persisted message does not match webhook identity')
      const threadId = this.encodeThreadId(message)
      if (outgoing) {
        if (!message.fromMe || message.deletedAt) return new Response('Ignored')
        const botSent =
          message.clientRequestId &&
          (await this.state().get(`zappaz:sent:${threadId}:${message.clientRequestId}`))
        const remaining =
          new Date(message.orderAt).getTime() + (this.config.humanPauseMs ?? 0) - Date.now()
        if (!botSent && remaining > 0)
          await this.pauseThread(
            threadId,
            Math.min(this.config.humanPauseMs ?? 1, Math.ceil(remaining)),
          )
        return new Response('OK')
      }
      if (message.fromMe || message.deletedAt || !inboundTypes.has(message.type))
        return new Response('Ignored', { status: 200 })
      if (await this.isThreadPaused(threadId)) return new Response('Paused')
      const parsed = this.parseMessage(message)
      if (this.buffer) {
        const fresh = await this.state().setIfNotExists(
          `zappaz:buffered:${threadId}:${message.id}`,
          true,
          300_000,
        )
        if (fresh) {
          const task = this.buffer.enqueue(parsed)
          options?.waitUntil?.(task)
        }
        return new Response('OK')
      }
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
    const attachments: Attachment[] = []
    const attachmentType = Object.hasOwn(attachmentTypes, message.type)
      ? attachmentTypes[message.type]
      : undefined
    if (attachmentType && !message.deletedAt) {
      const media = message.media
      if (
        media?.kind !== message.type ||
        media.sessionId !== message.sessionId ||
        media.conversationId !== message.conversationId ||
        media.messageRecordId !== message.id
      )
        throw new ValidationError('zappaz', 'Missing or mismatched persisted media')
      attachments.push(
        this.rehydrateAttachment({
          type: attachmentType,
          ...(media.mimeType ? { mimeType: media.mimeType } : {}),
          ...(media.fileName ? { name: media.fileName } : {}),
          ...(media.size !== null ? { size: media.size } : {}),
          ...(media.width !== null ? { width: media.width } : {}),
          ...(media.height !== null ? { height: media.height } : {}),
          fetchMetadata: {
            sessionId: message.sessionId,
            conversationId: message.conversationId,
            mediaId: media.id,
          },
        }),
      )
    }
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
      attachments,
    })
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    if (!attachment.fetchMetadata && attachment.type !== 'image') return attachment
    const metadata = z
      .object({ sessionId: z.string(), conversationId: z.uuid(), mediaId: z.uuid() })
      .safeParse(attachment.fetchMetadata)
    if (!metadata.success || metadata.data.sessionId !== this.config.sessionId)
      throw new ValidationError('zappaz', 'Invalid media attachment scope')
    const { conversationId, mediaId } = metadata.data
    return { ...attachment, fetchData: () => this.client.mediaData(conversationId, mediaId) }
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
    const results = await this.postMessages(threadId, message)
    const last = results.at(-1)
    if (!last) throw new ValidationError('zappaz', 'Nothing to send')
    return last
  }

  /** Returns every sent record when a post expands into multiple WhatsApp messages. */
  async postMessages(
    threadId: string,
    message: AdapterPostableMessage,
    replyToMessageRecordId?: string,
    signal?: AbortSignal,
  ): Promise<RawMessage<ZappazMessage>[]> {
    signal?.throwIfAborted()
    await this.ensureCanSend(threadId)
    if (replyToMessageRecordId) z.uuid().parse(replyToMessageRecordId)
    if (extractCard(message)) throw new NotImplementedError('Interactive cards are not supported')
    const files: FileUpload[] = [...extractFiles(message)]
    for (const attachment of extractPostableAttachments(message)) {
      if (!attachment.data)
        throw new ValidationError(
          'zappaz',
          'Outgoing attachments require binary data; URLs are not fetched',
        )
      files.push({
        data: attachment.data,
        filename: attachment.name ?? 'file',
        mimeType: attachment.mimeType,
      })
    }
    if (files.length > 10) throw new ValidationError('zappaz', 'At most 10 files per post')
    const prepared = files.map(prepareFile)
    const text = this.converter.renderPostable(message)
    if (text.length > 65_536 || (!text.trim() && !files.length))
      throw new ValidationError('zappaz', 'Provide text up to 65536 characters or files')
    if (text.length > 4096 && this.config.splitLongMessages === false)
      throw new ValidationError('zappaz', 'Text must contain 1–4096 characters')
    let caption = ''
    let texts: string[] = []
    if (text.trim()) {
      if (prepared.length && prepared[0]?.kind !== 'audio' && text.length <= 4096) caption = text
      else texts = splitText(text)
    }
    const results: RawMessage<ZappazMessage>[] = []
    for (const part of texts) {
      await this.ensureCanSend(threadId)
      signal?.throwIfAborted()
      const result = await this.client.request(
        `${this.path(threadId)}/messages/text`,
        z.object({ data: MessageSchema }),
        'POST',
        {
          text: part,
          clientRequestId: await this.requestId(threadId),
          signMessage: false,
          ...(replyToMessageRecordId ? { replyToMessageRecordId } : {}),
        },
      )
      results.push({ id: result.data.id, raw: result.data, threadId })
    }
    for (const { file, mimeType, kind } of prepared) {
      await this.ensureCanSend(threadId)
      signal?.throwIfAborted()
      const data = file.data instanceof Blob ? file.data : new Blob([new Uint8Array(file.data)])
      const form = new FormData()
      // The server detects MIME from bytes, not the supplied upload header.
      form.set('file', new Blob([data], { type: mimeType }), file.filename)
      form.set('kind', kind)
      form.set('clientRequestId', await this.requestId(threadId))
      if (caption) form.set('caption', caption)
      if (replyToMessageRecordId) form.set('replyToMessageRecordId', replyToMessageRecordId)
      const result = await this.client.request(
        `${this.path(threadId)}/messages/media`,
        z.object({ data: MessageSchema }),
        'POST',
        form,
      )
      results.push({ id: result.data.id, raw: result.data, threadId })
      caption = ''
    }
    return results
  }

  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZappazMessage>> {
    const results = await this.postMessages(threadId, message, z.uuid().parse(messageId))
    const last = results.at(-1)
    if (!last) throw new ValidationError('zappaz', 'Nothing to send')
    return last
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZappazMessage>> {
    await this.ensureCanSend(threadId)
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
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options.limit ?? 50)
    const page = (cursor?: string, direction = options.direction) => {
      const params = new URLSearchParams({
        limit: String(limit),
        ...(cursor ? { [direction === 'forward' ? 'after' : 'before']: cursor } : {}),
      })
      return this.client.request(
        `${this.path(threadId)}/messages?${params}`,
        z.object({
          data: z.array(MessageSchema),
          page: PageSchema,
          boundaries: z
            .object({ first: z.string().nullable(), last: z.string().nullable() })
            .optional(),
        }),
      )
    }
    let result = await page(options.cursor)
    let nextCursor = result.page.hasMore ? (result.page.nextCursor ?? undefined) : undefined
    // The API defaults to newest-first without a cursor. Seek the oldest page using only
    // server-issued cursors; never forge an opaque cursor or silently return the newest page.
    if (options.direction === 'forward' && !options.cursor) {
      const startedAt = Date.now()
      const seen = new Set<string>()
      while (result.page.hasMore) {
        const cursor = result.page.nextCursor
        if (!cursor || seen.has(cursor))
          throw new ValidationError('zappaz', 'Invalid history pagination cursor')
        if (seen.size >= 99 || Date.now() - startedAt > 30_000)
          throw new ValidationError(
            'zappaz',
            'Oldest-history seek exceeded its budget; provide a forward cursor',
          )
        seen.add(cursor)
        result = await page(cursor, 'backward')
      }
      nextCursor =
        seen.size && result.data.length ? (result.boundaries?.last ?? undefined) : undefined
      if (seen.size && result.data.length && !nextCursor)
        throw new ValidationError('zappaz', 'Missing history boundary for forward pagination')
    }
    return {
      messages: result.data.map((message) => this.parseMessage(message)),
      nextCursor,
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
    const results = await this.postMessages(
      threadId,
      { markdown: text },
      undefined,
      options?.signal,
    )
    const last = results.at(-1)
    if (!last) throw new ValidationError('zappaz', 'Nothing to send')
    return last
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
