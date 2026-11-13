# chat-adapter-zappaz

Adapter da [Zappaz](https://github.com/viiniolliveira/zappaz-lite) para o
[Chat SDK](https://chat-sdk.dev/), compatível com os
[channels do Mastra](https://mastra.ai/docs/channels).

Conecta um agente às mensagens individuais de WhatsApp de uma sessão Zappaz, usando somente a API
HTTP e os webhooks normalizados. O adapter roda **no consumidor**, não dentro da Zappaz, e não
depende de Prisma ou Baileys.

**Versão inicial experimental:** texto e histórico. Este repositório é público, mas o pacote ainda
não foi publicado no npm.

## Requisitos

- Uma instância Zappaz com API de conversas/mensagens e o novo contrato de webhooks: `id`
  (UUID interno), `messageId` (ID WhatsApp) e `conversationId`, sempre presentes e anuláveis.
  O contrato antigo não é suportado.
- Uma sessão WhatsApp conectada, habilitada e uma API Key autorizada para essa sessão.
- Chat SDK `^4.44.0` no consumidor; Node.js 22+ ou Bun.
- Bun para instalar, desenvolver e compilar este pacote ESM.

## Instalação sem npm

Clone e compile o adapter:

```bash
git clone https://github.com/viiniolliveira/chat-adapter-zappaz.git
cd chat-adapter-zappaz
bun install
bun run build
```

No seu projeto Chat SDK ou Mastra, instalado ao lado da pasta do adapter:

```bash
bun add chat ../chat-adapter-zappaz
```

O nome usado no import é `chat-adapter-zappaz`, conforme o manifesto, independentemente de ter sido
instalado pelo caminho local. O pacote fornece JavaScript ESM e declarações TypeScript em `dist/`.
`bun install` executa `prepare` para gerar o build; `bun run build` também pode ser executado
explicitamente. Não copie somente `src/index.ts`: o pacote inclui o cliente HTTP e o parser de
formatação, sem imports para arquivos da aplicação Zappaz.

## Configuração

```ts
import { createZappazAdapter } from 'chat-adapter-zappaz'

const adapter = createZappazAdapter({
  baseUrl: 'https://zappaz.example.com',
  apiKey: 'change-me',
  sessionId: 'ID_DA_SESSAO',
  webhookSecret: 'change-me-use-a-random-secret',
})
```

| Campo | Descrição |
| --- | --- |
| `baseUrl` | Origem HTTP(S) da Zappaz, sem `/api`, caminho, credenciais, query ou fragmento. |
| `apiKey` | API Key da Zappaz, preferencialmente restrita à sessão. |
| `sessionId` | Sessão atendida por esta instância do adapter. |
| `webhookSecret` | Segredo aleatório com pelo menos 16 caracteres, compartilhado com o webhook. |
| `userName` | Nome do bot; opcional, padrão `zappaz-bot`. |

O adapter não lê variáveis de ambiente automaticamente. Injete a configuração pelo consumidor,
valide seu ambiente na inicialização e nunca versione chaves reais. Use HTTPS fora do
desenvolvimento local. Para gerar um segredo localmente: `openssl rand -hex 32`.

## Usar com Mastra

Adicione esta configuração ao `Agent` existente:

```ts
import { createZappazAdapter } from 'chat-adapter-zappaz'

const channels = {
  adapters: {
    zappaz: {
      adapter: createZappazAdapter({
        baseUrl: 'https://zappaz.example.com',
        apiKey: 'change-me',
        sessionId: 'ID_DA_SESSAO',
        webhookSecret: 'change-me-use-a-random-secret',
      }),
      typingStatus: false,
      streaming: false,
      toolDisplay: 'text' as const,
      formatError: () => 'Não consegui responder. Tente novamente mais tarde.',
    },
  },
  tools: false,
}

// Passe `channels` no construtor do seu Agent.
```

Use uma versão do Mastra com channels (`@mastra/core >= 1.22.0`). Configure storage no Mastra para
persistir estado, inscrições e deduplicação. Configure `Memory` separadamente se quiser manter
contexto entre as respostas. Disponibilizar o histórico pela API do adapter não significa carregar
automaticamente o histórico anterior de uma DM no prompt.

Mastra registra a rota:

```text
POST /api/agents/ID_DO_AGENTE/channels/zappaz/webhook
```

Se o agente rodar localmente e a Zappaz estiver em um servidor, use um túnel HTTPS para **essa rota**.
Não exponha Studio, memória ou APIs administrativas sem autenticação. A Zappaz local não precisa
estar rodando quando o consumidor usa a instância remota.

Esta seção mostra a configuração de uso com Mastra; o repositório não inclui um agente de teste
executável. Mastra não é dependência deste pacote.

## Usar com Chat SDK diretamente

```ts
import { Chat } from 'chat'
import { createZappazAdapter } from 'chat-adapter-zappaz'

// `state` deve ser um StateAdapter configurado no seu consumidor.
const bot = new Chat({
  userName: 'meu-assistente',
  state,
  adapters: { zappaz: createZappazAdapter(config) },
})

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`Recebi: ${message.text}`)
})

// No endpoint HTTP do consumidor:
// return bot.webhooks.zappaz(request, { waitUntil })
```

`config`, `state`, `request` e `waitUntil` são fornecidos pelo consumidor. Em serverless, use o
mecanismo de continuação da plataforma para manter o processamento após a resposta HTTP.

## Configurar o webhook na Zappaz

Crie um webhook **na sessão escolhida**, apontando para a URL pública do consumidor. Habilite
somente `inbound-message.upsert` e adicione:

```json
{ "Authorization": "Bearer change-me-use-a-random-secret" }
```

O token Bearer deve ser o `webhookSecret` da configuração do adapter. É uma autenticação pelo
header `Authorization`, não uma assinatura HMAC do corpo. Não use a API Key como segredo do webhook.

- Header inválido: **401**.
- JSON ou mensagem inválida: **400**.
- Sessão diferente da configurada: **403**.
- Eventos não suportados, grupos, mensagens próprias e eventos sem UUID de mensagem ou conversa:
  **200**, sem acionar o agente.
- Falha ao localizar a mensagem persistida: **503**.
- Mensagem aceita para processamento: **200**; isso não garante que o agente já respondeu.

A Zappaz grava falhas de entrega nos logs; não presuma retry automático. Reenvios explícitos e
efeitos colaterais dos handlers precisam ser tratados com cuidado. A deduplicação do Chat SDK é
best effort e depende do state do consumidor. Use handlers idempotentes.

Para testar, envie texto **de outro número** para a sessão. Mensagens enviadas pela própria conta
são ignoradas para impedir loops. Quando terminar, desative o webhook; esta versão não filtra
prefixos nem contatos, e o handler pode responder a todo texto individual recebido.

## Identidade, histórico e limites

- Cada instância atende uma sessão. Thread IDs usam
  `zappaz:<sessão em base64url>:<UUID interno da conversa>`. Alterar o endereçamento entre PN e LID
  não troca o thread. A identidade vem dos UUIDs confirmados na persistência, nunca do nome ou JID.
- O webhook fornece `payload.message.id` (UUID interno), `payload.message.messageId` (ID WhatsApp)
  e `payload.message.conversationId` (UUID interno da conversa). A resolução faz uma única consulta:
  `GET /api/v1/session/:sessionId/conversations/:conversationId/messages/:messageRecordId`.
  Não pesquisa conversas, não percorre o histórico e não usa o ID WhatsApp como fallback.
  Eventos com `id` ou `conversationId` nulo são ignorados. A resposta precisa corresponder à sessão,
  conversa e UUID recebidos; o ID WhatsApp também é conferido quando não nulo no webhook.
- O ID da mensagem no Chat SDK é o UUID interno da Zappaz; o ID WhatsApp fica em
  `message.raw.messageId`. Edição e exclusão usam o UUID interno, escopado pela conversa e sessão.
- Não cria contatos na agenda, não abre conversas e não acessa diretamente o banco da Zappaz.
- `fromMe` não é convertido em `author.isMe`: uma mensagem manual do operador não é atribuída ao
  bot. Eventos de saída não iniciam execuções; não há pausa automática para atendimento humano.
- O texto vem do registro persistido. Mensagens removidas antes do processamento são ignoradas.
  Eventos de histórico/reenvios podem iniciar execuções quando ainda não deduplicados: o envelope
  atual não distingue sync de mensagem ao vivo.
- Envio, edição e exclusão para todos dependem das permissões e restrições do WhatsApp. Envios do
  adapter desativam a assinatura naquele envio, sem alterar a configuração da sessão.
- Histórico é retornado em ordem cronológica, com paginação **para trás** e cursores opacos.
  Paginação para frente lança `NotImplementedError` nesta versão.
- Markdown é convertido para a formatação WhatsApp. Títulos viram negrito e links preservam texto
  e destino. O parser de entrada usa os limites de segurança de `BaseFormatConverter.parseIncoming`.
- Texto final precisa ter **1–4096 caracteres**, não apenas espaços. Não há truncamento ou divisão
  automática. `stream()` acumula e envia uma única mensagem ao final, respeitando cancelamento e
  um orçamento de entrada de 65.536 caracteres; o limite final continua sendo 4096.
- Requisições têm timeout de 15 segundos. Escritas não são repetidas automaticamente, nem após
  timeout/5xx, para evitar envios duplicados. Redirecionamentos HTTP são recusados.
- Logs de resolução/dispatch usam o logger do Chat SDK, sem incluir segredo, payload ou texto.

### Ainda sem suporte

Mídias de entrada não acionam o agente. Arquivos de saída, cards, botões, reações e digitação
lançam erro explícito de recurso não implementado. Não adicione as ferramentas de reação do canal;
use `typingStatus: false` e `toolDisplay: 'text'` ou `'hidden'` no Mastra.

Ferramentas com `requireApproval` **não são suportadas** neste canal: cartões interativos não estão
implementados, mesmo com display em texto/oculto. Use outra UI/API/canal para aprovação explícita.
Uma mensagem recebida nunca é tratada automaticamente como consentimento.

## Desenvolvimento

```bash
bun install
bun run test
bun run typecheck
bun run lint
bun run build
```

Os testes usam o Chat SDK real com state em memória e HTTP simulado, sem banco, rede, modelo de IA
ou sessão WhatsApp real. O pacote original também foi validado de ponta a ponta com Zappaz e
Mastra; os testes automatizados não substituem a validação com a sua versão da API.

O manifesto usa `chat` como peer dependency para compartilhar o SDK do consumidor.
`@chat-adapter/shared` e Zod 4 são dependências de runtime. Testes, TypeScript e Biome são
somente de desenvolvimento. Bun compila o JavaScript e `tsc` gera os tipos. O build não inclui o
Chat SDK, credenciais ou dados de runtime.

## Referências

- [Construção de adapters](https://chat-sdk.dev/docs/contributing/building)
- [Mastra channels](https://mastra.ai/docs/channels)
- [Configuração de channels](https://mastra.ai/reference/agents/channels)
- [API e webhooks da Zappaz](https://github.com/viiniolliveira/zappaz-lite)

## Licença

[MIT](LICENSE).
