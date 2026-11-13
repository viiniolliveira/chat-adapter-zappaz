# AGENTS.md

## Code standards

- Use o `conversationId` interno, escopado por `sessionId`, como identificador canônico da conversa. Trate JID e LID como aliases que podem estar ausentes; preserve `chatId` como campo presente no webhook, cujo valor pode ser JID ou LID.
