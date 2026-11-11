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
import { Chat, type Message, NotImplementedError, parseMarkdown } from 'chat'
import {
  createZappazAdapter,
  ZappazAdapter,
  ZappazFormatConverter,
  type ZappazMessage,
} from '../src/index.ts'

const conversationId = '11111111-1111-4111-8111-111111111111'
const recordId = '22222222-2222-4222-8222-222222222222'
const otherRecordId = '33333333-3333-4333-8333-333333333333'
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
const conversation = {
  id: conversationId,
  sessionId: config.sessionId,
  jid: phone,
  isGroup: false,
  displayName: 'Maria',
  contact: { jid: phone, phoneNumber: '5511999999999', lid },
}
const page = { hasMore: false, nextCursor: null }

function request(body: unknown = webhook(), secret: string | null = config.webhookSecret): Request {
  return new Request('https://mastra.example/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }),
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
        id: raw.messageId,
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
    if (url.pathname.endsWith('/conversations'))
      return Response.json({ data: [conversation], page })
    return Response.json({ data: [raw], page })
  }
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(implementation, { preconnect }),
  )
  return fetchSpy
}

async function setup(handler: (message: Message) => Promise<void> = async () => {}) {
  const adapter = createZappazAdapter(config)
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
            headers: { Authorization: `Bearer ${config.webhookSecret}` },
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

  test('requires Bearer authorization and accepts case-insensitive header and scheme names', async () => {
    const adapter = createZappazAdapter(config)
    const body = JSON.stringify({ ...webhook(), event: 'connection.update' })
    const invalidHeaders: Record<string, string>[] = [
      { Authorization: config.webhookSecret },
      { Authorization: `Basic ${config.webhookSecret}` },
      { 'x-zappaz-webhook-secret': config.webhookSecret },
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
    const response = await adapter.handleWebhook(
      new Request('https://example.com', {
        method: 'POST',
        headers: { authorization: `bearer ${config.webhookSecret}` },
        body,
      }),
    )
    expect(response.status).toBe(200)
  })

  test('ignores outbound events, own-account echoes, groups and media before querying', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    for (const body of [
      { ...webhook(), event: 'outbound-message.upsert' },
      { ...webhook(), event: 'messages.send' },
      webhook({ fromMe: true }),
      webhook({ isGroup: true }),
      webhook({ type: 'image' }),
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
    mockApi(() => Response.json({ data: [], page }))
    const { adapter } = await setup()
    expect((await adapter.handleWebhook(request())).status).toBe(503)
  })

  test('matches identifiers exactly, never contact display names', async () => {
    mockApi(() =>
      Response.json({
        data: [{ ...conversation, jid: 'different@lid', contact: null, displayName: phone }],
        page,
      }),
    )
    const { adapter } = await setup()
    expect((await adapter.handleWebhook(request())).status).toBe(503)
  })

  test('paginates lookup of conversations and messages', async () => {
    const received: Message[] = []
    const tasks: Promise<unknown>[] = []
    const api = mockApi((url) => {
      const paginated = url.searchParams.has('cursor') || url.searchParams.has('before')
      return Response.json({
        data: paginated ? (url.pathname.endsWith('/conversations') ? [conversation] : [raw]) : [],
        page: paginated ? page : { hasMore: true, nextCursor: 'opaque-cursor' },
      })
    })
    const { adapter } = await setup(async (message) => {
      received.push(message)
    })
    expect(
      (
        await adapter.handleWebhook(request(), {
          waitUntil: (task) => {
            tasks.push(task)
          },
        })
      ).status,
    ).toBe(200)
    await Promise.all(tasks)
    expect(received).toHaveLength(1)
    expect(api).toHaveBeenCalledTimes(4)
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

  test('rejects blank, oversized, rich or file messages rather than silently dropping content', async () => {
    const api = mockApi()
    const adapter = createZappazAdapter(config)
    const threadId = adapter.encodeThreadId({ sessionId: config.sessionId, conversationId })
    for (const value of ['', ' ', 'x'.repeat(4097)])
      await expect(adapter.postMessage(threadId, value)).rejects.toBeInstanceOf(ValidationError)
    await expect(
      adapter.postMessage(threadId, {
        raw: 'file',
        files: [{ data: Buffer.from('test'), filename: 'test.txt' }],
      }),
    ).rejects.toBeInstanceOf(NotImplementedError)
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
    await expect(adapter.fetchMessages(threadId, { direction: 'forward' })).rejects.toBeInstanceOf(
      NotImplementedError,
    )
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
