import { z } from 'zod'

export interface ZappazAdapterConfig {
  baseUrl: string
  apiKey: string
  sessionId: string
  /** Configure the webhook header as Authorization: Bearer <webhookSecret>. */
  webhookSecret: string
  userName?: string
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
})

export const MessageSchema = z.object({
  id: z.uuid(),
  sessionId: z.string().min(1),
  conversationId: z.uuid(),
  messageId: z.string().min(1),
  fromMe: z.boolean(),
  sender: z.object({ jid: z.string().nullable(), name: z.string().nullable() }),
  type: z.string(),
  text: z.string().nullable(),
  orderAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
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
