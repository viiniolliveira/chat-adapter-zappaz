import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared'
import { z } from 'zod'
import {
  ConversationSchema,
  MessageSchema,
  PageSchema,
  type ZappazAdapterConfig,
  type ZappazMessage,
} from './types.ts'

export class ZappazClient {
  constructor(private readonly config: ZappazAdapterConfig) {}

  async request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(
        `${this.config.baseUrl}/api/v1/session/${encodeURIComponent(this.config.sessionId)}${path}`,
        {
          method,
          headers: {
            'x-api-key': this.config.apiKey,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch (error) {
      throw new NetworkError(
        'zappaz',
        'Zappaz request failed; writes are not retried automatically',
        error instanceof Error ? error : undefined,
      )
    }
    if (response.status === 401) throw new AuthenticationError('zappaz')
    if (response.status === 403) throw new PermissionError('zappaz', method)
    if (response.status === 404) throw new ResourceNotFoundError('zappaz', 'resource')
    if (response.status === 429) throw new AdapterRateLimitError('zappaz')
    if (response.status === 400 || response.status === 422)
      throw new ValidationError('zappaz', 'Zappaz rejected the request')
    if (!response.ok)
      throw new AdapterError(
        `Zappaz returned HTTP ${response.status}`,
        'zappaz',
        String(response.status),
      )
    let data: unknown
    try {
      data = await response.json()
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new ValidationError('zappaz', 'Invalid JSON from Zappaz API')
      throw new NetworkError(
        'zappaz',
        'Unable to read Zappaz API response',
        error instanceof Error ? error : undefined,
      )
    }
    const result = schema.safeParse(data)
    if (!result.success) throw new ValidationError('zappaz', 'Invalid Zappaz API response')
    return result.data
  }

  async conversationFor(identifiers: string[]): Promise<string> {
    const identities = new Set(identifiers)
    const query = identifiers[0].split('@')[0]
    let cursor: string | null = null
    do {
      const params: URLSearchParams = new URLSearchParams({
        q: query,
        limit: '100',
        ...(cursor ? { cursor } : {}),
      })
      const result = await this.request(
        `/conversations?${params}`,
        z.object({ data: z.array(ConversationSchema), page: PageSchema }),
      )
      const match = result.data.find((conversation) => {
        const contact = conversation.contact
        return [
          conversation.jid,
          contact?.jid,
          contact?.lid,
          contact?.phoneNumber ? `${contact.phoneNumber}@s.whatsapp.net` : null,
        ].some((id) => id !== null && id !== undefined && identities.has(id))
      })
      if (match) return match.id
      cursor = result.page.hasMore ? result.page.nextCursor : null
    } while (cursor)
    throw new ResourceNotFoundError('zappaz', 'conversation')
  }

  async messageFor(conversationId: string, messageId: string): Promise<ZappazMessage> {
    let cursor: string | null = null
    do {
      const params: URLSearchParams = new URLSearchParams({
        limit: '100',
        ...(cursor ? { before: cursor } : {}),
      })
      const result = await this.request(
        `/conversations/${conversationId}/messages?${params}`,
        z.object({ data: z.array(MessageSchema), page: PageSchema }),
      )
      const match = result.data.find((message) => message.messageId === messageId)
      if (match) return match
      cursor = result.page.hasMore ? result.page.nextCursor : null
    } while (cursor)
    throw new ResourceNotFoundError('zappaz', 'message', messageId)
  }
}
