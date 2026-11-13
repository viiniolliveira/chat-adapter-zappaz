import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared'
import { createMemoryState } from '@chat-adapter/state-memory'
import { Chat, type Message, NotImplementedError, parseMarkdown, toAiMessages } from 'chat'
import {
  createZappazAdapter,
  ZappazAdapter,
  type ZappazAdapterConfig,
  ZappazFormatConverter,
  type ZappazMessage,
} from '../src/index.ts'
import { MessageBuffer } from '../src/message-buffer.ts'

const conversationId = '11111111-1111-4111-8111-111111111111'
const recordId = '22222222-2222-4222-8222-222222222222'
const otherRecordId = '33333333-3333-4333-8333-333333333333'
const mediaId = '44444444-4444-4444-8444-444444444444'
const phone = '5511999999999@s.whatsapp.net'
const lid = '123456789@lid'
const config = {
  baseUrl: 'https://zappaz.example',
  apiKey: 'test-api-key',
  sessionId: 'session:one',
  webhookSecret: 'test-webhook-secret',
}
const raw: ZappazMessage = {
  id: recordId,
  conversationId,
  sessionId: config.sessionId,
  messageId: 'WA123',
  fromMe: false,
  sender: { jid: phone, name: 'Maria' },
  type: 'text',
  text: '*Olá*',
  orderAt: '2026-11-11T12:00:00.000Z',
  editedAt: null,
  deletedAt: null,
}
const image = {
  ...raw,
  type: 'image',
  text: '*Confira* esta foto',
  media: {
    id: mediaId,
    sessionId: config.sessionId,
    conversationId,
    messageRecordId: recordId,
    kind: 'image',
    mimeType: 'image/png',
    fileName: 'foto.png',
    size: 4,
    width: 100,
    height: 80,
  },
} satisfies ZappazMessage
const conversation = {
  id: conversationId,
  sessionId: config.sessionId,
  jid: phone,
  isGroup: false,
  displayName: 'Maria',
  contact: { jid: phone, phoneNumber: '5511999999999', lid },
}

function request(body: unknown = webhook(), secret: string | null = config.webhookSecret): Request {
  return new Request('https://mastra.example/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'X-Zappaz-Webhook-Secret': secret }),
    },
    body: JSON.stringify(body),
  })
}

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    event: 'inbound-message.upsert',
    session: { id: config.sessionId },
    payload: {
      message: {
        id: recordId,
        messageId: raw.messageId,
        conversationId,
        chatId: phone,
        remoteJid: phone,
        lid,
        fromMe: false,
        isGroup: false,
        type: 'text',
        ...overrides,
      },
    },
  }
}

const bots: Chat[] = []
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined

afterEach(async () => {
  await Promise.all(bots.splice(0).map((bot) => bot.shutdown()))
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

function mockApi(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const preconnect = globalThis.fetch.preconnect
  const implementation = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe(config.baseUrl)
    expect(new Headers(init?.headers).get('x-api-key')).toBe(config.apiKey)
    expect(init?.redirect).toBe('error')
    if (handler) return handler(url, init)
    return Response.json({ data: raw })
  }
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(implementation, { preconnect }),
  )
  return fetchSpy
}

async function setup(
  handler: (message: Message) => Promise<void> = async () => {},
  overrides: Partial<ZappazAdapterConfig> = {},
) {
  const adapter = createZappazAdapter({ ...config, ...overrides })
  const bot = new Chat({
    userName: 'test',
    adapters: { zappaz: adapter },
    state: createMemoryState(),
    logger: 'silent',
  })
  bots.push(bot)
  bot.onDirectMessage(async (_thread, message) => handler(message))
  await bot.initialize()
  return { adapter, bot }
}

describe('Zappaz Chat SDK adapter', () => {
  test('validates factory and direct constructor configuration', () => {
    for (const override of [
      { baseUrl: '' },
      { baseUrl: 'invalid-url' },
      { baseUrl: 'file:///secret' },
      { baseUrl: 'https://user:password@example.com' },
      { baseUrl: 'https://example.com/path' },
      { baseUrl: 'https://example.com?token=secret' },
      { apiKey: '' },
      { sessionId: '' },
      { webhookSecret: 'short' },
      { debounceMs: -1 },
      { debounceMs: 60_001 },
      { humanPauseMs: -1 },
      { humanPauseMs: 2_147_483_648 },
      { allowedUsers: { conversationIds: ['not-a-uuid'] } },
      { allowedUsers: { conversationIds: [''] } },
    ]) {
      expect(() => createZappazAdapter({ ...config, ...override })).toThrow(ValidationError)
      expect(() => new ZappazAdapter({ ...config, ...override })).toThrow(ValidationError)
    }
    expect(() => createZappazAdapter({ ...config, baseUrl: `${config.baseUrl}/` })).not.toThrow()
  })

  test('roundtrips stable conversation IDs and rejects cross-session threads', () => {
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    expect(adapter.decodeThreadId(threadId)).toEqual({
      sessionId: config.sessionId,
      conversationId,
    })
    expect(adapter.channelIdFromThreadId(threadId)).toBe(threadId)
    expect(adapter.isDM(threadId)).toBe(true)
    expect(() =>
      createZappazAdapter({ ...config, sessionId: 'other' }).decodeThreadId(threadId),
    ).toThrow(ValidationError)
    for (const invalid of [
      'zappaz:!!:bad',
      `${threadId}:extra`,
      `${threadId}:`,
      threadId.replace('zappaz:', 'slack:'),
    ])
      expect(() => adapter.decodeThreadId(invalid)).toThrow(ValidationError)
  })

  test('parses persisted messages without labeling human outgoing messages as bot echoes', () => {
    const adapter = createZappazAdapter(config)
    const parsed = adapter.parseMessage(raw)
    expect(parsed.id).toBe(recordId)
    expect(parsed.raw.messageId).toBe('WA123')
    expect(parsed.text).toBe('Olá')
    expect(parsed.metadata.dateSent.toISOString()).toBe(raw.orderAt)
    expect(adapter.parseMessage({ ...raw, fromMe: true }).author.isMe).toBe(false)
    expect(adapter.parseMessage({ ...raw, deletedAt: raw.orderAt }).text).toBe('[Mensagem apagada]')
  })

  test('authenticates before parsing or querying the API', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    for (const secret of [null, 'wrong', 'x'.repeat(config.webhookSecret.length)])
      expect((await adapter.handleWebhook(request({}, secret))).status).toBe(401)
    expect(api).not.toHaveBeenCalled()
  })

  test('rejects malformed payloads and foreign sessions', async () => {
    const adapter = createZappazAdapter(config)
    expect(
      (
        await adapter.handleWebhook(
          new Request('https://example.com', {
            method: 'POST',
            headers: { 'X-Zappaz-Webhook-Secret': config.webhookSecret },
            body: '{',
          }),
        )
      ).status,
    ).toBe(400)
    expect((await adapter.handleWebhook(request({}))).status).toBe(400)
    expect((await adapter.handleWebhook(request({ ...webhook(), payload: {} }))).status).toBe(400)
    expect(
      (await adapter.handleWebhook(request({ ...webhook(), session: { id: 'other' } }))).status,
    ).toBe(403)
    expect((await adapter.handleWebhook(request())).status).toBe(503)
  })

  test('requires the Zappaz webhook secret header without a Bearer fallback', async () => {
    const adapter = createZappazAdapter(config)
    const body = JSON.stringify({ ...webhook(), event: 'connection.update' })
    const invalidHeaders: Record<string, string>[] = [
      { Authorization: config.webhookSecret },
      { Authorization: `Basic ${config.webhookSecret}` },
      { Authorization: `Bearer ${config.webhookSecret}` },
      { 'X-Zappaz-Webhook-Secret': `Bearer ${config.webhookSecret}` },
      {
        Authorization: `Bearer ${config.webhookSecret}`,
        'X-Zappaz-Webhook-Secret': 'wrong',
      },
    ]
    for (const headers of invalidHeaders) {
      expect(
        (
          await adapter.handleWebhook(
            new Request('https://example.com', { method: 'POST', headers, body }),
          )
        ).status,
      ).toBe(401)
    }
    for (const header of ['X-Zappaz-Webhook-Secret', 'x-zappaz-webhook-secret']) {
      const response = await adapter.handleWebhook(
        new Request('https://example.com', {
          method: 'POST',
          headers: { [header]: config.webhookSecret },
          body,
        }),
      )
      expect(response.status).toBe(200)
    }
  })

  test('ignores outbound events, own-account echoes, groups and unsupported media before querying', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    for (const body of [
      { ...webhook(), event: 'outbound-message.upsert' },
      { ...webhook(), event: 'messages.send' },
      webhook({ fromMe: true }),
      webhook({ isGroup: true }),
      webhook({ type: 'poll' }),
      webhook({ type: 'image', fromMe: true }),
      webhook({ type: 'image', isGroup: true }),
    ])
      expect((await adapter.handleWebhook(request(body))).status).toBe(200)
    expect(api).not.toHaveBeenCalled()
  })

  test('dispatches a real SDK DM and deduplicates webhook delivery', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi()
    const { bot } = await setup(async (message) => {
      received.push(message)
    })
    for (let count = 0; count < 2; count++) {
      expect(
        (
          await bot.webhooks.zappaz(request(), {
            waitUntil: (task) => {
              tasks.push(task)
            },
          })
        ).status,
      ).toBe(200)
      await Promise.all(tasks)
    }
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe(recordId)
    expect(received[0].text).toBe('Olá')
  })

  test('acknowledges without waiting for the user handler to finish', async () => {
    mockApi()
    const tasks: Promise<unknown>[] = []
    const gate = Promise.withResolvers<void>()
    let finished = false
    const { adapter } = await setup(async () => {
      await gate.promise
      finished = true
    })
    try {
      const response = await adapter.handleWebhook(request(), {
        waitUntil: (task) => {
          tasks.push(task)
        },
      })
      expect(response.status).toBe(200)
      expect(finished).toBe(false)
    } finally {
      gate.resolve()
      await Promise.all(tasks)
    }
    expect(finished).toBe(true)
  })

  test('keeps the thread stable when webhook addressing changes between PN and LID', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi()
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    expect(
      (
        await adapter.handleWebhook(request(webhook({ chatId: lid, remoteJid: null })), {
          waitUntil: (task) => {
            tasks.push(task)
          },
        })
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received[0].threadId).toBe(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
    )
  })

  test('returns 503 instead of accepting an unresolved persisted message', async () => {
    const api = mockApi(() => new Response(null, { status: 404 }))
    const { adapter } = await setup()
    expect((await adapter.handleWebhook(request())).status).toBe(503)
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('rejects persisted messages that do not match the webhook identity', async () => {
    const received: Message[] = []
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    for (const override of [
      { sessionId: 'other-session' },
      { conversationId: otherRecordId },
      { id: otherRecordId },
      { messageId: 'OTHER_WA_ID' },
    ]) {
      const api = mockApi(() => Response.json({ data: { ...raw, ...override } }))
      expect((await adapter.handleWebhook(request())).status).toBe(503)
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
    expect(received).toHaveLength(0)
  })

  test('fetches the persisted message by internal UUID in a single request', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const api = mockApi((url, init) => {
      expect(init?.method).toBe('GET')
      expect(url.pathname).toBe(
        `/api/v1/session/session%3Aone/conversations/${conversationId}/messages/${recordId}`,
      )
      expect(url.search).toBe('')
      return Response.json({ data: raw })
    })
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    expect(
      (
        await adapter.handleWebhook(request(webhook({ text: 'Untrusted webhook text' })), {
          waitUntil: (task) => {
            tasks.push(task)
          },
        })
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe(recordId)
    expect(received[0].raw).toMatchObject({ messageId: raw.messageId })
    expect(received[0].text).toBe('Olá')
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('ignores events without a persisted record without querying or inventing IDs', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    for (const override of [
      { id: null },
      { conversationId: null },
      { id: null, conversationId: null, messageId: null, chatId: null },
      { id: null, conversationId: null, type: 'reaction' },
    ])
      expect((await adapter.handleWebhook(request(webhook(override)))).status).toBe(200)
    expect(api).not.toHaveBeenCalled()
  })

  test('rejects legacy or malformed webhook identities without fallback', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    const legacy = webhook().payload.message as Record<string, unknown>
    legacy.id = raw.messageId
    delete legacy.messageId
    delete legacy.conversationId
    expect(
      (await adapter.handleWebhook(request({ ...webhook(), payload: { message: legacy } }))).status,
    ).toBe(400)
    for (const override of [
      { id: raw.messageId },
      { conversationId: 'invalid' },
      { id: undefined },
      { conversationId: undefined },
      { messageId: undefined },
      { messageId: '' },
      { chatId: undefined },
      { chatId: '' },
    ])
      expect((await adapter.handleWebhook(request(webhook(override)))).status).toBe(400)
    expect(api).not.toHaveBeenCalled()
  })

  test('resolves internal IDs even when WhatsApp addressing fields are null', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const api = mockApi()
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    const response = await adapter.handleWebhook(
      request(webhook({ messageId: null, chatId: null, remoteJid: null, lid: null })),
      { waitUntil: (task) => tasks.push(task) },
    )
    expect(response.status).toBe(200)
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(received[0].raw).toMatchObject({ messageId: raw.messageId })
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('ignores persisted outgoing, deleted and non-text messages', async () => {
    const received: Message[] = []
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    for (const override of [{ fromMe: true }, { deletedAt: raw.orderAt }, { type: 'poll' }]) {
      const api = mockApi(() => Response.json({ data: { ...raw, ...override } }))
      expect((await adapter.handleWebhook(request())).status).toBe(200)
      api.mockRestore()
    }
    expect(received).toHaveLength(0)
  })

  test('sends formatted text with an internal request ID and without session signatures', async () => {
    const api = mockApi((_url, init) => {
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.text).toBe('*Olá*')
      expect(body.signMessage).toBe(false)
      expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/)
      return Response.json({ data: { ...raw, fromMe: true } })
    })
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    const result = await adapter.postMessage(threadId, { markdown: '**Olá**' })
    expect(result).toMatchObject({ id: recordId, threadId })
    expect(String(api.mock.calls[0][0])).toContain('session%3Aone')
  })

  test('rejects blank, oversized, interactive or URL-only content before sending', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    for (const value of ['', ' ', 'x'.repeat(65_537)])
      await expect(adapter.postMessage(threadId, value)).rejects.toBeInstanceOf(ValidationError)
    await expect(
      adapter.postMessage(threadId, {
        raw: 'file',
        attachments: [{ type: 'file', url: 'https://untrusted.example/test.txt' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      adapter.postMessage(threadId, { type: 'card', children: [] }),
    ).rejects.toBeInstanceOf(NotImplementedError)
    expect(api).not.toHaveBeenCalled()
  })

  test('edits and deletes by internal message UUID', async () => {
    const methods: string[] = []
    mockApi((url, init) => {
      expect(url.pathname).toEndWith(`/messages/${recordId}`)
      methods.push(init?.method ?? '')
      return Response.json({ data: raw })
    })
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    await adapter.editMessage(threadId, recordId, 'Atualizado')
    await adapter.deleteMessage(threadId, recordId)
    expect(methods).toEqual(['PATCH', 'DELETE'])
  })

  test('returns chronological history and preserves opaque backward cursors', async () => {
    mockApi((url) => {
      expect(url.searchParams.get('before')).toBe('opaque/+cursor')
      expect(url.searchParams.get('limit')).toBe('2')
      return Response.json({
        data: [raw, { ...raw, id: otherRecordId, orderAt: '2026-11-11T12:01:00.000Z' }],
        page: { hasMore: true, nextCursor: 'next/+cursor' },
      })
    })
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    const result = await adapter.fetchMessages(threadId, { cursor: 'opaque/+cursor', limit: 2 })
    expect(result.messages.map((message) => message.id)).toEqual([recordId, otherRecordId])
    expect(result.nextCursor).toBe('next/+cursor')
  })

  test('fetches DM metadata', async () => {
    mockApi(() => Response.json({ data: conversation }))
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    expect(await adapter.fetchThread(threadId)).toMatchObject({
      id: threadId,
      channelId: threadId,
      channelName: 'Maria',
      isDM: true,
    })
  })

  test('buffers stream chunks and posts once instead of editing per token', async () => {
    const api = mockApi((_url, init) => {
      expect(JSON.parse(String(init?.body)).text).toBe('*Olá*')
      return Response.json({ data: raw })
    })
    const adapter = createZappazAdapter(config)
    async function* chunks() {
      yield '**'
      yield { type: 'markdown_text' as const, text: 'Olá**' }
    }
    await adapter.stream(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
      chunks(),
    )
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('does not send an aborted stream', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    async function* chunks() {
      yield 'Olá'
    }
    await expect(
      adapter.stream(
        adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
        chunks(),
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow()
    expect(api).not.toHaveBeenCalled()
  })

  test('maps HTTP failures to Chat SDK adapter errors without retrying writes', async () => {
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    for (const [status, ErrorClass] of [
      [401, AuthenticationError],
      [403, PermissionError],
      [404, ResourceNotFoundError],
      [429, AdapterRateLimitError],
      [400, ValidationError],
    ] as const) {
      const api = mockApi(() => new Response('', { status }))
      await expect(adapter.postMessage(threadId, 'Olá')).rejects.toBeInstanceOf(ErrorClass)
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
    const api = mockApi(() => {
      throw new Error('offline')
    })
    await expect(adapter.postMessage(threadId, 'Olá')).rejects.toBeInstanceOf(NetworkError)
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('rejects invalid API response shapes', async () => {
    mockApi(() => Response.json({ data: {} }))
    const adapter = createZappazAdapter(config)
    await expect(
      adapter.postMessage(
        adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
        'Olá',
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('rejects non-JSON API responses as validation errors', async () => {
    mockApi(() => new Response('<html>Invalid upstream</html>'))
    const adapter = createZappazAdapter(config)
    await expect(
      adapter.postMessage(
        adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
        'Olá',
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('extended delivery features', () => {
  test('accepts audio, documents, video and stickers with authenticated lazy downloads', async () => {
    for (const [type, attachmentType, mimeType] of [
      ['audio', 'audio', 'audio/ogg'],
      ['document', 'file', 'application/pdf'],
      ['video', 'video', 'video/mp4'],
      ['sticker', 'image', 'image/webp'],
    ] as const) {
      const received: Message[] = []
      const tasks: Promise<unknown>[] = []
      const fixture = {
        ...image,
        type,
        text: null,
        media: { ...image.media, kind: type, mimeType },
      }
      const api = mockApi((url) =>
        url.pathname.endsWith('/content')
          ? new Response('media')
          : Response.json({ data: fixture }),
      )
      const { adapter } = await setup(async (message) => {
        received.push(message)
      })
      expect(
        (
          await adapter.handleWebhook(request(webhook({ type })), {
            waitUntil: (task) => tasks.push(task),
          })
        ).status,
      ).toBe(200)
      await Promise.all(tasks)
      expect(received).toHaveLength(1)
      expect(received[0].attachments[0].type).toBe(attachmentType)
      expect(received[0].attachments[0].mimeType).toBe(mimeType)
      expect(api).toHaveBeenCalledTimes(1)
      const serialized = JSON.parse(JSON.stringify(received[0].attachments[0]))
      expect(await adapter.rehydrateAttachment(serialized).fetchData?.()).toEqual(
        Buffer.from('media'),
      )
      api.mockRestore()
    }
  })

  test('uploads images and documents with multipart forms and a caption on the first file', async () => {
    const forms: FormData[] = []
    const api = mockApi((url, init) => {
      expect(url.pathname).toEndWith(`/conversations/${conversationId}/messages/media`)
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).has('content-type')).toBe(false)
      expect(init?.body).toBeInstanceOf(FormData)
      forms.push(init?.body as FormData)
      return Response.json({ data: { ...raw, id: forms.length === 1 ? recordId : otherRecordId } })
    })
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    const result = await adapter.postMessages(threadId, {
      markdown: '**Confira**',
      files: [
        { data: Buffer.from('image'), filename: 'photo.png' },
        { data: new Blob(['pdf']), filename: 'report.pdf' },
      ],
    })
    expect(result.map((message) => message.id)).toEqual([recordId, otherRecordId])
    expect(forms[0].get('kind')).toBe('image')
    expect(forms[0].get('caption')).toBe('*Confira*')
    expect(forms[1].get('kind')).toBe('document')
    expect(forms[1].get('caption')).toBeNull()
    expect((forms[0].get('file') as File).name).toBe('photo.png')
    expect(await (forms[0].get('file') as File).text()).toBe('image')
    expect(forms[0].get('clientRequestId')).not.toBe(forms[1].get('clientRequestId'))
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('preserves text when sending audio and accepts binary postable attachments', async () => {
    const paths: string[] = []
    mockApi((url, init) => {
      paths.push(url.pathname)
      if (init?.body instanceof FormData) {
        expect(init.body.get('kind')).toBe('audio')
        expect(init.body.get('caption')).toBeNull()
      } else expect(JSON.parse(String(init?.body)).text).toBe('Ouça')
      return Response.json({ data: raw })
    })
    const adapter = createZappazAdapter(config)
    await adapter.postMessage(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
      {
        raw: 'Ouça',
        attachments: [
          { type: 'audio', data: Buffer.from('audio'), name: 'voice.ogg', mimeType: 'audio/ogg' },
        ],
      },
    )
    expect(paths[0]).toEndWith('/messages/text')
    expect(paths[1]).toEndWith('/messages/media')
  })

  test('validates all uploads before sending anything', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    for (const files of [
      [{ data: Buffer.alloc(0), filename: 'empty.pdf' }],
      [{ data: Buffer.alloc(25 * 1024 * 1024 + 1), filename: 'large.pdf' }],
      [{ data: Buffer.from('ok'), filename: '' }],
      Array.from({ length: 11 }, () => ({ data: Buffer.from('ok'), filename: 'file.pdf' })),
    ])
      await expect(
        adapter.postMessage(threadId, { raw: 'Do not send', files }),
      ).rejects.toBeInstanceOf(ValidationError)
    expect(api).not.toHaveBeenCalled()
  })

  test('quotes internal message UUIDs for both text and file replies', async () => {
    const api = mockApi((_url, init) => {
      const quoted =
        init?.body instanceof FormData
          ? init.body.get('replyToMessageRecordId')
          : JSON.parse(String(init?.body)).replyToMessageRecordId
      expect(quoted).toBe(recordId)
      return Response.json({ data: raw })
    })
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    await adapter.reply(threadId, recordId, 'Resposta')
    await adapter.reply(threadId, recordId, {
      raw: '',
      files: [{ data: Buffer.from('pdf'), filename: 'file.pdf' }],
    })
    expect(api).toHaveBeenCalledTimes(2)
    await expect(adapter.reply(threadId, 'WA123', 'Invalid')).rejects.toThrow()
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('splits long text without losing content or breaking surrogate pairs', async () => {
    const sent: string[] = []
    mockApi((_url, init) => {
      sent.push(JSON.parse(String(init?.body)).text)
      return Response.json({ data: { ...raw, id: sent.length === 1 ? recordId : otherRecordId } })
    })
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    const text = `${'a'.repeat(4095)}😀${'b'.repeat(5000)}`
    const records = await adapter.postMessages(threadId, { raw: text })
    expect(records).toHaveLength(3)
    expect(sent.join('')).toBe(text)
    expect(
      sent.every((part) => part.length <= 4096 && !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(part)),
    ).toBe(true)
  })

  test('supports disabling splitting and keeps edits limited to one message', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter({ ...config, splitLongMessages: false })
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    await expect(adapter.postMessage(threadId, { raw: 'x'.repeat(4097) })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(
      adapter.editMessage(threadId, recordId, { raw: 'x'.repeat(4097) }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(api).not.toHaveBeenCalled()
  })

  test('stops split streaming when aborted between sends', async () => {
    const controller = new AbortController()
    const api = mockApi(() => {
      controller.abort()
      return Response.json({ data: raw })
    })
    const adapter = createZappazAdapter(config)
    async function* chunks() {
      yield 'x'.repeat(9000)
    }
    await expect(
      adapter.stream(
        adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
        chunks(),
        { signal: controller.signal },
      ),
    ).rejects.toThrow()
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('stops multipart output when human handling starts between sends', async () => {
    const { adapter } = await setup(async () => {}, { humanPauseMs: 60_000 })
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    const api = mockApi(async () => {
      await adapter.pauseThread(threadId)
      return Response.json({ data: raw })
    })
    await expect(adapter.postMessage(threadId, { raw: 'x'.repeat(9000) })).rejects.toBeInstanceOf(
      PermissionError,
    )
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('does not retry or continue a multipart post after a partial failure', async () => {
    let count = 0
    const api = mockApi(() => {
      count++
      return count === 1 ? Response.json({ data: raw }) : new Response(null, { status: 503 })
    })
    const adapter = createZappazAdapter(config)
    await expect(
      adapter.postMessage(adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }), {
        raw: 'x'.repeat(12_000),
      }),
    ).rejects.toThrow()
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('paginates forward using after and preserves chronological messages', async () => {
    mockApi((url) => {
      expect(url.searchParams.get('after')).toBe('opaque/+cursor')
      expect(url.searchParams.has('before')).toBe(false)
      return Response.json({ data: [raw], page: { hasMore: true, nextCursor: 'next' } })
    })
    const adapter = createZappazAdapter(config)
    const result = await adapter.fetchMessages(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
      {
        direction: 'forward',
        cursor: 'opaque/+cursor',
      },
    )
    expect(result.messages[0].id).toBe(recordId)
    expect(result.nextCursor).toBe('next')
  })

  test('starts forward history at the oldest page without inventing opaque cursors', async () => {
    const api = mockApi((url) => {
      if (url.searchParams.has('before')) {
        expect(url.searchParams.get('before')).toBe('older-page')
        return Response.json({
          data: [{ ...raw, id: otherRecordId, text: 'Oldest' }],
          page: { hasMore: false, nextCursor: null },
          boundaries: { first: 'oldest-first', last: 'oldest-last' },
        })
      }
      return Response.json({ data: [raw], page: { hasMore: true, nextCursor: 'older-page' } })
    })
    const adapter = createZappazAdapter(config)
    const result = await adapter.fetchMessages(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
      { direction: 'forward' },
    )
    expect(result.messages[0].text).toBe('Oldest')
    expect(result.nextCursor).toBe('oldest-last')
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('rejects repeated cursors instead of looping during a forward-history seek', async () => {
    const api = mockApi(() =>
      Response.json({ data: [raw], page: { hasMore: true, nextCursor: 'repeated' } }),
    )
    const adapter = createZappazAdapter(config)
    await expect(
      adapter.fetchMessages(
        adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
        { direction: 'forward' },
      ),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('batches messages into one execution without losing text or media and deduplicates delivery', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi((url) =>
      Response.json({
        data: url.pathname.endsWith(otherRecordId)
          ? {
              ...image,
              id: otherRecordId,
              messageId: 'WA456',
              media: { ...image.media, messageRecordId: otherRecordId },
            }
          : raw,
      }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { debounceMs: 20 },
    )
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) }
    await adapter.handleWebhook(request(), options)
    await adapter.handleWebhook(request(), options)
    await adapter.handleWebhook(
      request(webhook({ id: otherRecordId, messageId: 'WA456', type: 'image' })),
      options,
    )
    expect(received).toHaveLength(0)
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe(otherRecordId)
    expect(received[0].text).toContain('Olá')
    expect(received[0].text).toContain('Confira')
    expect(received[0].attachments).toHaveLength(1)
  })

  test('enqueues debounce work even when waitUntil is not provided', async () => {
    const done = Promise.withResolvers<Message>()
    mockApi()
    const { adapter } = await setup(
      async (message) => {
        done.resolve(message)
      },
      { debounceMs: 1 },
    )
    expect((await adapter.handleWebhook(request())).status).toBe(200)
    expect((await done.promise).id).toBe(recordId)
  })

  test('cancels pending debounce work and resolves waitUntil on disconnect', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi()
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { debounceMs: 60_000 },
    )
    expect(
      (await adapter.handleWebhook(request(), { waitUntil: (task) => tasks.push(task) })).status,
    ).toBe(200)
    await adapter.disconnect()
    await Promise.all(tasks)
    expect(received).toHaveLength(0)
  })

  test('bounds a continuously growing batch to 100 messages', async () => {
    const sizes: number[] = []
    const buffer = new MessageBuffer(
      1,
      async (messages) => {
        sizes.push(messages.length)
      },
      () => {},
    )
    const message = createZappazAdapter(config).parseMessage(raw)
    const tasks = Array.from({ length: 101 }, () => buffer.enqueue(message))
    await Promise.all(tasks)
    expect(sizes).toEqual([100, 1])
    await buffer.disconnect()
  })

  test('keeps debounce batches isolated across conversations', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi((url) =>
      Response.json({
        data: url.pathname.endsWith(otherRecordId)
          ? {
              ...raw,
              id: otherRecordId,
              messageId: 'WA456',
              conversationId: otherRecordId,
              text: 'Outra conversa',
            }
          : raw,
      }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { debounceMs: 10 },
    )
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) }
    await adapter.handleWebhook(request(), options)
    await adapter.handleWebhook(
      request(webhook({ id: otherRecordId, conversationId: otherRecordId, messageId: 'WA456' })),
      options,
    )
    await Promise.all(tasks)
    expect(received).toHaveLength(2)
    expect(new Set(received.map((message) => message.threadId)).size).toBe(2)
    expect(received.map((message) => message.text).sort()).toEqual(['Olá', 'Outra conversa'])
  })

  test('pauses on human outbound messages, blocks sends and can resume manually', async () => {
    const received: Message[] = []
    let outgoing = true
    mockApi(() =>
      Response.json({
        data: outgoing
          ? {
              ...raw,
              fromMe: true,
              orderAt: new Date().toISOString(),
              clientRequestId: 'operator-request',
            }
          : raw,
      }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { humanPauseMs: 60_000 },
    )
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    expect(
      (
        await adapter.handleWebhook(
          request({ ...webhook({ fromMe: true }), event: 'outbound-message.upsert' }),
        )
      ).status,
    ).toBe(200)
    expect(await adapter.isThreadPaused(threadId)).toBe(true)
    await expect(adapter.postMessage(threadId, 'Do not send')).rejects.toBeInstanceOf(
      PermissionError,
    )
    outgoing = false
    expect((await adapter.handleWebhook(request())).status).toBe(200)
    expect(received).toHaveLength(0)
    await adapter.resumeThread(threadId)
    expect(await adapter.isThreadPaused(threadId)).toBe(false)
    const tasks: Promise<unknown>[] = []
    await adapter.handleWebhook(request(), { waitUntil: (task) => tasks.push(task) })
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
  })

  test('does not pause on bot echoes even if the outbound webhook arrives before the send returns', async () => {
    let saved: ZappazMessage = raw
    const { adapter } = await setup(async () => {}, { humanPauseMs: 60_000 })
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    mockApi(async (_url, init) => {
      if (init?.method === 'POST') {
        saved = {
          ...raw,
          fromMe: true,
          orderAt: new Date().toISOString(),
          clientRequestId: JSON.parse(String(init.body)).clientRequestId,
        }
        expect(
          (
            await adapter.handleWebhook(
              request({ ...webhook({ fromMe: true }), event: 'messages.send' }),
            )
          ).status,
        ).toBe(200)
      }
      return Response.json({ data: saved })
    })
    await adapter.postMessage(threadId, 'Bot response')
    expect(await adapter.isThreadPaused(threadId)).toBe(false)
  })

  test('ignores historical outgoing messages and cancels pending batches on manual pause', async () => {
    const received: Message[] = []
    let outgoing = true
    mockApi(() => Response.json({ data: { ...raw, fromMe: outgoing } }))
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { humanPauseMs: 60_000, debounceMs: 60_000 },
    )
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    await adapter.handleWebhook(
      request({ ...webhook({ fromMe: true }), event: 'outbound-message.upsert' }),
    )
    expect(await adapter.isThreadPaused(threadId)).toBe(false)
    outgoing = false
    const tasks: Promise<unknown>[] = []
    await adapter.handleWebhook(request(), { waitUntil: (task) => tasks.push(task) })
    await adapter.pauseThread(threadId)
    await Promise.all(tasks)
    expect(received).toHaveLength(0)
    expect(await adapter.isThreadPaused(threadId)).toBe(true)
  })

  test('manual pauses work with automatic detection disabled and do not shorten a longer pause', async () => {
    const { adapter } = await setup(async () => {}, { humanPauseMs: 0 })
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    await adapter.pauseThread(threadId)
    await adapter.pauseThread(threadId, 1)
    expect(await adapter.isThreadPaused(threadId)).toBe(true)
    await expect(adapter.editMessage(threadId, recordId, 'blocked')).rejects.toBeInstanceOf(
      PermissionError,
    )
    await adapter.resumeThread(threadId)
    expect(await adapter.isThreadPaused(threadId)).toBe(false)
  })
})

describe('incoming images', () => {
  test('dispatches image DMs with persisted captions and lazy authenticated attachments', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const bytes = Buffer.from([137, 80, 78, 71])
    const api = mockApi((url) => {
      if (url.pathname.endsWith('/content')) {
        expect(url.pathname).toEndWith(`/conversations/${conversationId}/media/${mediaId}/content`)
        return new Response(bytes, { headers: { 'content-type': 'image/png' } })
      }
      expect(url.pathname).toEndWith(`/messages/${recordId}`)
      return Response.json({ data: image })
    })
    const { bot, adapter } = await setup(async (message) => {
      received.push(message)
    })
    const response = await bot.webhooks.zappaz(
      request(webhook({ type: 'image', text: 'Do not use this caption' })),
      { waitUntil: (task) => tasks.push(task) },
    )
    expect(response.status).toBe(200)
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(api).toHaveBeenCalledTimes(1)
    const message = received[0]
    expect(message.threadId).toBe(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
    )
    expect(message.text).toBe('Confira esta foto')
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      name: 'foto.png',
      size: 4,
      width: 100,
      height: 80,
      fetchMetadata: { sessionId: config.sessionId, conversationId, mediaId },
    })
    expect(message.attachments[0].url).toBeUndefined()
    expect(JSON.stringify(message)).not.toContain(config.apiKey)
    expect(await message.attachments[0].fetchData?.()).toEqual(bytes)
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('supports images without captions and conversion to AI messages', async () => {
    const bytes = Buffer.from([137, 80, 78, 71])
    mockApi(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    const message = createZappazAdapter(config).parseMessage({ ...image, text: null })
    expect(message.text).toBe('[image]')
    expect(message.attachments).toHaveLength(1)
    const messages = await toAiMessages([message])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(messages)).toContain('image/png')
  })

  test('returns image attachments in history without downloading them', async () => {
    const api = mockApi(() =>
      Response.json({ data: [image], page: { hasMore: false, nextCursor: null } }),
    )
    const adapter = createZappazAdapter(config)
    const result = await adapter.fetchMessages(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
    )
    expect(result.messages[0].attachments[0].type).toBe('image')
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('rehydrates serialized image attachments without following external URLs', async () => {
    const bytes = Buffer.from([137, 80, 78, 71])
    const api = mockApi(() => new Response(bytes))
    const adapter = createZappazAdapter(config)
    const original = adapter.parseMessage(image).attachments[0]
    const serialized = JSON.parse(JSON.stringify(original))
    serialized.url = 'https://untrusted.example/image.png'
    const attachment = adapter.rehydrateAttachment(serialized)
    expect(await attachment.fetchData?.()).toEqual(bytes)
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('rejects foreign or invalid image scopes before downloading', () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    for (const fetchMetadata of [
      undefined,
      { sessionId: 'other', conversationId, mediaId },
      { sessionId: config.sessionId, conversationId: '../escape', mediaId },
      { sessionId: config.sessionId, conversationId, mediaId: 'https://evil.example' },
    ])
      expect(() => adapter.rehydrateAttachment({ type: 'image', fetchMetadata })).toThrow(
        ValidationError,
      )
    expect(api).not.toHaveBeenCalled()
  })

  test('rejects images with missing or mismatched persisted media', async () => {
    const { adapter } = await setup()
    for (const media of [
      null,
      { ...image.media, sessionId: 'other' },
      { ...image.media, conversationId: otherRecordId },
      { ...image.media, messageRecordId: otherRecordId },
      { ...image.media, kind: 'video' },
    ]) {
      const api = mockApi(() => Response.json({ data: { ...image, media } }))
      expect((await adapter.handleWebhook(request(webhook({ type: 'image' })))).status).toBe(503)
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
  })

  test('does not expose attachments on deleted images', () => {
    const parsed = createZappazAdapter(config).parseMessage({
      ...image,
      deletedAt: raw.orderAt,
      media: null,
    })
    expect(parsed.text).toBe('[Mensagem apagada]')
    expect(parsed.attachments).toHaveLength(0)
  })

  test('maps download HTTP errors without retrying', async () => {
    for (const [status, ErrorClass] of [
      [401, AuthenticationError],
      [403, PermissionError],
      [404, ResourceNotFoundError],
      [429, AdapterRateLimitError],
    ] as const) {
      const api = mockApi(() => new Response(null, { status }))
      const attachment = createZappazAdapter(config).parseMessage(image).attachments[0]
      await expect(attachment.fetchData?.()).rejects.toBeInstanceOf(ErrorClass)
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
  })

  test('rejects empty and oversized image downloads', async () => {
    for (const response of [
      new Response(null),
      new Response(new Uint8Array(0)),
      new Response('too large', { headers: { 'content-length': String(26 * 1024 * 1024) } }),
      new Response(new Uint8Array(25 * 1024 * 1024 + 1)),
    ]) {
      const api = mockApi(() => response)
      const attachment = createZappazAdapter(config).parseMessage(image).attachments[0]
      await expect(attachment.fetchData?.()).rejects.toBeInstanceOf(ValidationError)
      api.mockRestore()
    }
  })

  test('reports failures while reading the image body', async () => {
    mockApi(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('download interrupted'))
            },
          }),
        ),
    )
    const attachment = createZappazAdapter(config).parseMessage(image).attachments[0]
    await expect(attachment.fetchData?.()).rejects.toBeInstanceOf(NetworkError)
  })
})

describe('WhatsApp format conversion', () => {
  const converter = new ZappazFormatConverter()
  test('converts Markdown to WhatsApp without leaking Markdown links or double delimiters', () => {
    expect(
      converter.fromAst(parseMarkdown('**bold** _italic_ ~~removed~~ [site](https://example.com)')),
    ).toBe('*bold* _italic_ ~removed~ site (https://example.com)')
    expect(converter.fromAst(parseMarkdown('# Title\n\n- first\n- second'))).toBe(
      '*Title*\n\n- first\n- second',
    )
  })
  test('parses incoming WhatsApp styles and leaves Markdown double markers literal', () => {
    expect(converter.parseIncoming('*bold* _italic_ ~removed~ `code`').text).toBe(
      'bold italic removed code',
    )
    expect(converter.parseIncoming('**literal**').text).toBe('**literal**')
  })
  test('uses the SDK parse budget for oversized untrusted input', () => {
    const value = '*'.repeat(20_000)
    expect(converter.parseIncoming(value).text).toBe(value)
  })
})

describe('allowed users', () => {
  test('matches exact trimmed identifiers across lists without a conversation lookup', async () => {
    for (const allowedUsers of [
      { jids: [` ${phone} `] },
      { jids: ['unrelated'], lids: [' 123456789 '] },
      { lids: [lid] },
      { chatIds: [phone] },
      { conversationIds: [conversationId] },
      { conversationIds: [otherRecordId], lids: [lid] },
    ]) {
      const received: Message[] = []
      const tasks: Promise<unknown>[] = []
      const api = mockApi()
      const { adapter } = await setup(
        async (message) => {
          received.push(message)
        },
        { allowedUsers },
      )
      expect(
        (await adapter.handleWebhook(request(), { waitUntil: (task) => tasks.push(task) })).status,
      ).toBe(200)
      await Promise.all(tasks)
      expect(received).toHaveLength(1)
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
  })

  test('empty policies and non-exact identifiers deny without dispatch', async () => {
    for (const allowedUsers of [
      {},
      { conversationIds: [], jids: [], lids: [], chatIds: [] },
      { jids: ['5511999999999'] },
    ]) {
      const received: Message[] = []
      const api = mockApi((url) =>
        Response.json({ data: url.pathname.endsWith(conversationId) ? conversation : raw }),
      )
      const { adapter } = await setup(
        async (message) => {
          received.push(message)
        },
        { allowedUsers },
      )
      const response = await adapter.handleWebhook(request())
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('Ignored')
      expect(received).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(allowedUsers.jids?.length ? 2 : 1)
      api.mockRestore()
    }
  })

  test('allows the canonical conversation with optional aliases absent and keeps the thread across chatId changes', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const api = mockApi((url) =>
      Response.json({
        data: {
          ...raw,
          ...(url.pathname.endsWith(otherRecordId)
            ? { id: otherRecordId, messageId: 'WA456' }
            : url.pathname.endsWith(mediaId)
              ? { id: mediaId, messageId: 'WA789' }
              : {}),
          sender: { name: 'Maria' },
        },
      }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { allowedUsers: { conversationIds: [conversationId] } },
    )
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) }
    expect(
      (
        await adapter.handleWebhook(
          request(webhook({ chatId: phone, remoteJid: undefined, lid: undefined })),
          options,
        )
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(
      (
        await adapter.handleWebhook(
          request(
            webhook({
              id: otherRecordId,
              messageId: 'WA456',
              chatId: phone,
              remoteJid: phone,
              lid: null,
            }),
          ),
          options,
        )
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(
      (
        await adapter.handleWebhook(
          request(webhook({ id: mediaId, messageId: 'WA789', chatId: lid, remoteJid: null, lid })),
          options,
        )
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received).toHaveLength(3)
    expect(received.map((message) => message.threadId)).toEqual([
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
    ])
    expect(api).toHaveBeenCalledTimes(3)
  })

  test('denies a non-allowlisted canonical conversation without alias lookup or audio transcription', async () => {
    const received: Message[] = []
    let transcriptionCount = 0
    const voice = {
      ...image,
      type: 'audio',
      text: null,
      media: { ...image.media, kind: 'audio', voice: true },
    }
    const api = mockApi(() => Response.json({ data: voice }))
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      {
        allowedUsers: { conversationIds: [otherRecordId] },
        transcribeAudio: async () => {
          transcriptionCount++
          return 'transcription'
        },
      },
    )
    const response = await adapter.handleWebhook(request(webhook({ type: 'audio' })))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('Ignored')
    expect(api).toHaveBeenCalledTimes(1)
    expect(transcriptionCount).toBe(0)
    expect(received).toHaveLength(0)
  })

  test('does not interpret a configured chatId UUID as the persisted conversation ID', async () => {
    const received: Message[] = []
    const api = mockApi((url) =>
      Response.json({ data: url.pathname.endsWith(conversationId) ? conversation : raw }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { allowedUsers: { chatIds: [conversationId] } },
    )
    const response = await adapter.handleWebhook(request())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('Ignored')
    expect(received).toHaveLength(0)
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('validates persisted identity before allowing a matching canonical conversation', async () => {
    const received: Message[] = []
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { allowedUsers: { conversationIds: [conversationId] } },
    )
    for (const override of [
      { id: otherRecordId },
      { conversationId: otherRecordId },
      { sessionId: 'other-session' },
      { messageId: 'OTHER_WA_ID' },
    ]) {
      const api = mockApi(() => Response.json({ data: { ...raw, ...override } }))
      expect((await adapter.handleWebhook(request())).status).toBe(503)
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
    expect(received).toHaveLength(0)
  })

  test('resolves conversation aliases only after confirming persisted identity', async () => {
    for (const allowedUsers of [{ jids: [phone] }, { lids: [lid] }, { chatIds: [phone] }]) {
      const received: Message[] = []
      const tasks: Promise<unknown>[] = []
      const api = mockApi((url) =>
        Response.json({
          data: url.pathname.endsWith(conversationId)
            ? conversation
            : { ...raw, sender: { ...raw.sender, jid: null } },
        }),
      )
      const { adapter } = await setup(
        async (message) => {
          received.push(message)
        },
        { allowedUsers },
      )
      expect(
        (
          await adapter.handleWebhook(
            request(webhook({ remoteJid: null, lid: null, chatId: null })),
            { waitUntil: (task) => tasks.push(task) },
          )
        ).status,
      ).toBe(200)
      await Promise.all(tasks)
      expect(received).toHaveLength(1)
      expect(api).toHaveBeenCalledTimes(2)
      expect(new URL(String(api.mock.calls[1][0])).pathname).toEndWith(
        `/conversations/${conversationId}`,
      )
      api.mockRestore()
    }
  })

  test('fails closed on invalid or unavailable conversation aliases and mismatched message identity', async () => {
    for (const result of [
      null,
      { ...conversation, id: otherRecordId },
      { ...conversation, sessionId: 'other' },
    ]) {
      const received: Message[] = []
      const api = mockApi((url) =>
        url.pathname.endsWith(conversationId)
          ? result
            ? Response.json({ data: result })
            : new Response(null, { status: 500 })
          : Response.json({ data: raw }),
      )
      const { adapter } = await setup(
        async (message) => {
          received.push(message)
        },
        { allowedUsers: { jids: ['other@example.com'] } },
      )
      expect((await adapter.handleWebhook(request())).status).toBe(503)
      expect(received).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(2)
      api.mockRestore()
    }
    const api = mockApi(() => Response.json({ data: { ...raw, id: otherRecordId } }))
    const { adapter } = await setup(async () => {}, { allowedUsers: { jids: [phone] } })
    expect((await adapter.handleWebhook(request())).status).toBe(503)
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('does not trust an outbound sender as the recipient when deciding human pause', async () => {
    const api = mockApi((url) =>
      Response.json({
        data: url.pathname.endsWith(conversationId)
          ? { ...conversation, jid: 'other@s.whatsapp.net', contact: null }
          : { ...raw, fromMe: true, orderAt: new Date().toISOString() },
      }),
    )
    const { adapter } = await setup(async () => {}, {
      humanPauseMs: 60_000,
      allowedUsers: { jids: [phone] },
    })
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    const response = await adapter.handleWebhook(
      request({
        ...webhook({ fromMe: true, remoteJid: null, lid: null, chatId: null }),
        event: 'outbound-message.upsert',
      }),
    )
    expect(response.status).toBe(200)
    expect(await adapter.isThreadPaused(threadId)).toBe(false)
    expect(api).toHaveBeenCalledTimes(2)
  })
})

describe('voice transcription', () => {
  const voice = {
    ...image,
    type: 'audio',
    text: null,
    media: { ...image.media, kind: 'audio', mimeType: null, fileName: null, voice: true },
  } satisfies ZappazMessage

  test('downloads authenticated voice bytes, normalizes metadata and dispatches transcription with raw attachment', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const bytes = Buffer.from('voice bytes')
    const api = mockApi((url) =>
      url.pathname.endsWith('/content') ? new Response(bytes) : Response.json({ data: voice }),
    )
    const calls: unknown[] = []
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      {
        transcribeAudio: async (input) => {
          calls.push(input)
          return 'Olá transcrito'
        },
      },
    )
    expect(
      (
        await adapter.handleWebhook(request(webhook({ type: 'audio' })), {
          waitUntil: (task) => tasks.push(task),
        })
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      data: bytes,
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      voice: true,
      message: voice,
    })
    expect(received).toHaveLength(1)
    expect(received[0].text).toBe('Olá transcrito')
    expect(received[0].raw).toMatchObject(voice)
    expect(received[0].attachments[0]).toMatchObject({
      type: 'audio',
      mimeType: 'audio/ogg',
      name: 'voice.ogg',
    })
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('normalizes MIME parameters and keeps voice downloads lazy without a callback', async () => {
    const api = mockApi(() => new Response('voice'))
    const adapter = createZappazAdapter(config)
    for (const mimeType of [null, '  ', ' Audio/OGG; codecs=opus ']) {
      const attachment = adapter.parseMessage({ ...voice, media: { ...voice.media, mimeType } })
        .attachments[0]
      expect(attachment).toMatchObject({ mimeType: 'audio/ogg', name: 'voice.ogg' })
      expect(api).toHaveBeenCalledTimes(0)
      expect(
        await adapter.rehydrateAttachment(JSON.parse(JSON.stringify(attachment))).fetchData?.(),
      ).toEqual(Buffer.from('voice'))
      api.mockClear()
    }
  })

  test('does not download or transcribe denied audio', async () => {
    let transcriptions = 0
    const api = mockApi(() => Response.json({ data: voice }))
    const { adapter } = await setup(
      async () => {
        throw new Error('unexpected dispatch')
      },
      {
        allowedUsers: {},
        transcribeAudio: async () => {
          transcriptions++
          return 'text'
        },
      },
    )
    const response = await adapter.handleWebhook(request(webhook({ type: 'audio' })))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('Ignored')
    expect(transcriptions).toBe(0)
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('fails closed on transcription errors and blank results', async () => {
    for (const transcribeAudio of [
      async () => {
        throw new Error('failed')
      },
      async () => ' \n ',
    ]) {
      const received: Message[] = []
      const api = mockApi((url) =>
        url.pathname.endsWith('/content') ? new Response('voice') : Response.json({ data: voice }),
      )
      const { adapter } = await setup(
        async (message) => {
          received.push(message)
        },
        { transcribeAudio },
      )
      expect((await adapter.handleWebhook(request(webhook({ type: 'audio' })))).status).toBe(503)
      expect(received).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(2)
      api.mockRestore()
    }
  })

  test('retains transcribed text in a debounced batch', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi((url) =>
      url.pathname.endsWith('/content')
        ? new Response('voice')
        : Response.json({
            data: url.pathname.endsWith(otherRecordId)
              ? {
                  ...voice,
                  id: otherRecordId,
                  messageId: 'WA456',
                  media: { ...voice.media, messageRecordId: otherRecordId },
                }
              : raw,
          }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { debounceMs: 20, transcribeAudio: async () => 'fala transcrita' },
    )
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) }
    await adapter.handleWebhook(request(), options)
    await adapter.handleWebhook(
      request(webhook({ id: otherRecordId, messageId: 'WA456', type: 'audio' })),
      options,
    )
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(received[0].text).toContain('Olá')
    expect(received[0].text).toContain('fala transcrita')
    expect(received[0].text).not.toContain('[audio]')
    expect(received[0].attachments).toHaveLength(1)
  })
})

describe('incoming quoted messages', () => {
  const quote = {
    messageRecordId: otherRecordId,
    messageId: 'QUOTED_WA_ID',
    senderJid: '198831635488829@lid',
    fromMe: false,
    type: 'text',
    text: 'Recebi a imagem!',
  }
  const marker = '[Mensagem citada (contexto, não é a mensagem atual)]'
  const end = '[Fim da mensagem citada]'
  const context = (id: string, sender: string | null, text: string, body: string) =>
    `${marker}\nID: ${id}${sender ? `\nRemetente: ${sender}` : ''}\n${text}\n${end}\n\n${body}`

  test('includes the persisted quote as context in parsed messages and history', async () => {
    const quoted = { ...raw, text: 'Qual é a resposta?', replyTo: quote }
    const adapter = createZappazAdapter(config)
    const parsed = adapter.parseMessage(quoted)
    expect(parsed.text).toBe(
      context(otherRecordId, quote.senderJid, quote.text, 'Qual é a resposta?'),
    )
    expect(parsed.raw).toMatchObject({ replyTo: quote })
    expect(parsed.replyTo).toBeUndefined()
    const api = mockApi(() =>
      Response.json({ data: [quoted], page: { hasMore: false, nextCursor: null } }),
    )
    const history = await adapter.fetchMessages(
      adapter.encodeThreadId({ sessionId: config.sessionId, conversationId }),
    )
    expect(history.messages[0].text).toBe(parsed.text)
    expect(history.messages[0].raw).toMatchObject({ replyTo: quote })
    expect(api).toHaveBeenCalledTimes(1)
  })

  test('falls back to the authenticated user-shaped webhook snapshot when persisted reply is absent or null', async () => {
    for (const persistedReply of [undefined, null]) {
      const received: Message[] = []
      const tasks: Promise<unknown>[] = []
      const api = mockApi(() =>
        Response.json({ data: { ...raw, text: 'E agora?', replyTo: persistedReply } }),
      )
      const { adapter } = await setup(
        async (message) => {
          received.push(message)
        },
        { allowedUsers: { lids: [lid] } },
      )
      const event = webhook({
        sender: { id: '' },
        remoteJid: phone,
        lid,
        chatId: lid,
        replyTo: {
          id: '3EB01CCCEC09D8E6A13B8F',
          text: 'Recebi a imagem!...',
          type: 'text',
          senderId: '198831635488829@lid',
        },
      })
      const response = await adapter.handleWebhook(request(event), {
        waitUntil: (task) => tasks.push(task),
      })
      expect(response.status).toBe(200)
      await Promise.all(tasks)
      expect(received).toHaveLength(1)
      expect(received[0].text).toBe(
        context('3EB01CCCEC09D8E6A13B8F', '198831635488829@lid', 'Recebi a imagem!...', 'E agora?'),
      )
      expect(received[0].raw).toMatchObject({
        replyTo: {
          messageId: '3EB01CCCEC09D8E6A13B8F',
          senderJid: '198831635488829@lid',
          type: 'text',
          text: 'Recebi a imagem!...',
        },
      })
      expect(received[0].replyTo).toBeUndefined()
      expect(api).toHaveBeenCalledTimes(1)
      api.mockRestore()
    }
  })

  test('prefers persisted context over a conflicting webhook snapshot', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    mockApi(() => Response.json({ data: { ...raw, text: 'Pergunta atual?', replyTo: quote } }))
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    const event = webhook({
      replyTo: { id: 'UNTRUSTED_ID', senderId: phone, type: 'text', text: 'Outro texto' },
    })
    expect(
      (await adapter.handleWebhook(request(event), { waitUntil: (task) => tasks.push(task) }))
        .status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received[0].text).toBe(
      context(otherRecordId, quote.senderJid, quote.text, 'Pergunta atual?'),
    )
    expect(received[0].raw).toMatchObject({ replyTo: quote })
    expect(received[0].text).not.toContain('Outro texto')
  })

  test('handles absent and deleted quotes and renders media quotes without downloading them', () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    expect(adapter.parseMessage(raw).text).toBe('Olá')
    expect(adapter.parseMessage({ ...raw, replyTo: null }).text).toBe('Olá')
    const deleted = { ...raw, deletedAt: raw.orderAt, replyTo: quote }
    expect(adapter.parseMessage(deleted).text).toBe('[Mensagem apagada]')
    const mediaQuote = {
      ...raw,
      text: 'O que disse?',
      replyTo: { messageId: 'MEDIA_ID', senderJid: null, type: 'audio', text: null },
    }
    expect(adapter.parseMessage(mediaQuote).text).toBe(
      context('MEDIA_ID', null, '[audio]', 'O que disse?'),
    )
    expect(api).not.toHaveBeenCalled()
  })

  test('limits quoted text to 8192 characters without truncating the current message', () => {
    const longQuote = {
      ...raw,
      text: 'Pergunta atual?',
      replyTo: { ...quote, text: 'x'.repeat(9000) },
    }
    const result = createZappazAdapter(config).parseMessage(longQuote).text
    expect(result).toContain('x'.repeat(8192))
    expect(result).not.toContain('x'.repeat(8193))
    expect(result).toEndWith(`${end}\n\nPergunta atual?`)
  })

  test('preserves quoted context around a live audio transcription', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const voice = {
      ...image,
      type: 'audio',
      text: null,
      replyTo: quote,
      media: {
        ...image.media,
        kind: 'audio',
        voice: true,
        mimeType: 'audio/ogg',
        fileName: 'voice.ogg',
      },
    }
    const api = mockApi((url) =>
      url.pathname.endsWith('/content') ? new Response('voice') : Response.json({ data: voice }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { transcribeAudio: async () => 'Qual é o valor?' },
    )
    expect(
      (
        await adapter.handleWebhook(request(webhook({ type: 'audio' })), {
          waitUntil: (task) => tasks.push(task),
        })
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received[0].text).toBe(
      context(otherRecordId, quote.senderJid, quote.text, 'Qual é o valor?'),
    )
    expect(received[0].raw).toMatchObject({ replyTo: quote })
    expect(received[0].attachments).toHaveLength(1)
    expect(api).toHaveBeenCalledTimes(2)
  })

  test('keeps each quote exactly once in a debounced batch', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const secondQuote = {
      ...quote,
      messageRecordId: null,
      messageId: 'SECOND_QUOTE',
      text: 'Segundo contexto',
    }
    mockApi((url) =>
      Response.json({
        data: url.pathname.endsWith(otherRecordId)
          ? {
              ...raw,
              id: otherRecordId,
              messageId: 'WA456',
              text: 'Segunda pergunta?',
              replyTo: secondQuote,
            }
          : { ...raw, text: 'Primeira pergunta?', replyTo: quote },
      }),
    )
    const { adapter } = await setup(
      async (message) => {
        received.push(message)
      },
      { debounceMs: 20 },
    )
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) }
    expect((await adapter.handleWebhook(request(), options)).status).toBe(200)
    expect(
      (
        await adapter.handleWebhook(
          request(webhook({ id: otherRecordId, messageId: 'WA456' })),
          options,
        )
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(received[0].text).toContain(
      context(otherRecordId, quote.senderJid, quote.text, 'Primeira pergunta?'),
    )
    expect(received[0].text).toContain(
      context('SECOND_QUOTE', secondQuote.senderJid, secondQuote.text, 'Segunda pergunta?'),
    )
    expect(received[0].text.split(marker)).toHaveLength(3)
    expect(received[0].text.split(end)).toHaveLength(3)
  })

  test('does not dispatch or use webhook quotes before authentication, validation and identity checks', async () => {
    const received: Message[] = []
    const api = mockApi(() => Response.json({ data: { ...raw, id: otherRecordId } }))
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    const replyTo = { id: 'QUOTED', text: 'texto', type: 'text', senderId: lid }
    expect((await adapter.handleWebhook(request(webhook({ replyTo }), 'wrong'))).status).toBe(401)
    expect(api).not.toHaveBeenCalled()
    expect(
      (await adapter.handleWebhook(request(webhook({ replyTo: { ...replyTo, id: '' } })))).status,
    ).toBe(400)
    expect(api).not.toHaveBeenCalled()
    expect((await adapter.handleWebhook(request(webhook({ replyTo })))).status).toBe(503)
    expect(api).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(0)
  })
})
