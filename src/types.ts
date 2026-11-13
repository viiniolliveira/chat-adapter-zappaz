import { z } from 'zod'

export interface ZappazAdapterConfig {
  baseUrl: string
  apiKey: string
  sessionId: string
  /** Must match the Zappaz webhook secret sent in X-Zappaz-Webhook-Secret. */
  webhookSecret: string
  userName?: string
  /** Text batching window; 0 disables batching. Requires a long-lived process or waitUntil. */
  debounceMs?: number
  /** Pause automatic dispatch/sends after a human outgoing message; 0 disables it. */
  humanPauseMs?: number
  /** Split long outgoing text into messages of at most 4096 characters. Default: true. */
  splitLongMessages?: boolean
}

export interface ZappazThreadId {
  sessionId: string
  conversationId: string
}

export const ConfigSchema = z.object({
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .transform((value) => new URL(value))
    .refine((url) => {
      return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    }, 'baseUrl must be an HTTP(S) origin')
    .transform((url) => url.origin),
  apiKey: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  webhookSecret: z.string().min(16),
  userName: z.string().trim().min(1).optional(),
  debounceMs: z.number().int().min(0).max(60_000).optional(),
  humanPauseMs: z.number().int().min(0).max(2_147_483_647).optional(),
  splitLongMessages: z.boolean().optional(),
})

export const MediaSchema = z.object({
  id: z.uuid(),
  sessionId: z.string().min(1),
  conversationId: z.uuid(),
  messageRecordId: z.uuid(),
  kind: z.enum(['image', 'video', 'audio', 'document', 'sticker']),
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  size: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  duration: z.number().nonnegative().nullable().optional(),
  voice: z.boolean().optional(),
})

export const MessageSchema = z.object({
  id: z.uuid(),
  sessionId: z.string().min(1),
  conversationId: z.uuid(),
  messageId: z.string().min(1),
  clientRequestId: z.string().nullable().optional(),
  fromMe: z.boolean(),
  sender: z.object({ jid: z.string().nullable(), name: z.string().nullable() }),
  type: z.string(),
  text: z.string().nullable(),
  orderAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  media: MediaSchema.nullable().optional(),
})
export type ZappazMessage = z.infer<typeof MessageSchema>

export const ConversationSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  jid: z.string(),
  displayName: z.string(),
  isGroup: z.literal(false),
  contact: z
    .object({ jid: z.string(), phoneNumber: z.string().nullable(), lid: z.string().nullable() })
    .nullable(),
})

export const PageSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export const WebhookSchema = z.object({
  event: z.string(),
  session: z.object({ id: z.string().min(1) }),
  payload: z.unknown(),
})

export const IncomingMessageSchema = z.object({
  message: z.object({
    id: z.uuid().nullable(),
    messageId: z.string().min(1).nullable(),
    conversationId: z.uuid().nullable(),
    chatId: z.string().min(1).nullable(),
    remoteJid: z.string().nullable(),
    lid: z.string().nullable(),
    fromMe: z.boolean(),
    isGroup: z.boolean(),
    type: z.string(),
  }),
})
