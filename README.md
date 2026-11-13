# @zappaz/chat-adapter-zappaz

Adapter da [Zappaz](https://github.com/viiniolliveira/zappaz-lite) para o
[Chat SDK](https://chat-sdk.dev/), compatível com os
[channels do Mastra](https://mastra.ai/docs/channels).

Conecta um agente às mensagens individuais de WhatsApp de uma sessão Zappaz, usando somente a API
HTTP e os webhooks normalizados. O adapter roda **no consumidor**, não dentro da Zappaz, e não
depende de Prisma ou Baileys.

**Versão experimental:** texto e arquivos, citação de mensagens, histórico bidirecional,
agrupamento opcional de mensagens e pausa para atendimento humano.

## Requisitos

- Uma instância Zappaz com API de conversas/mensagens e o novo contrato de webhooks: `id`
  (UUID interno), `messageId` (ID WhatsApp) e `conversationId`, sempre presentes e anuláveis.
  O contrato antigo não é suportado.
- Uma sessão WhatsApp conectada, habilitada e uma API Key autorizada para essa sessão.
- Chat SDK `^4.44.0` no consumidor; Node.js 22+ ou Bun.
- Bun para instalar, desenvolver e compilar este pacote ESM.

## Instalação

```bash
bun add chat @zappaz/chat-adapter-zappaz
```

### Instalação local para desenvolvimento

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

O nome usado no import é `@zappaz/chat-adapter-zappaz`, conforme o manifesto, independentemente de ter sido
instalado pelo caminho local. O pacote fornece JavaScript ESM e declarações TypeScript em `dist/`.
`bun install` executa `prepare` para gerar o build; `bun run build` também pode ser executado
explicitamente. Não copie somente `src/index.ts`: o pacote inclui o cliente HTTP e o parser de
formatação, sem imports para arquivos da aplicação Zappaz.

## Configuração

```ts
import { createZappazAdapter } from '@zappaz/chat-adapter-zappaz'

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
| `debounceMs` | Janela de agrupamento, de 0 a 60.000 ms. Padrão: 0 (desativado). |
| `humanPauseMs` | Duração da pausa após saída humana, até 2.147.483.647 ms. Padrão: 0 (desativado). |
| `splitLongMessages` | Divide textos longos em partes de até 4.096 caracteres. Padrão: `true`. |
| `allowedUsers` | Lista de permissões por `conversationIds` (preferencial), `jids`, `lids` ou `chatIds`. Ausente permite todos; vazia não permite ninguém. |
| `transcribeAudio` | Callback opcional que recebe áudio autenticado e retorna texto antes de acionar o agente. |

O adapter não lê variáveis de ambiente automaticamente. Injete a configuração pelo consumidor,
valide seu ambiente na inicialização e nunca versione chaves reais. Use HTTPS fora do
desenvolvimento local. Para gerar um segredo localmente: `openssl rand -hex 32`.

## Usar com Mastra

Adicione esta configuração ao `Agent` existente:

```ts
import { createZappazAdapter } from '@zappaz/chat-adapter-zappaz'

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

### Permitir somente alguns usuários

```ts
const adapter = createZappazAdapter({
  ...config,
  allowedUsers: {
    conversationIds: ['11111111-1111-4111-8111-111111111111'],
  },
})
```

Prefira `conversationIds`: é o UUID interno estável da conversa na sessão configurada. Ele é
comparado com a mensagem persistida antes de qualquer alias, mesmo sem JID/LID no webhook.
Não é o ID da thread interna do Mastra. O UUID acima é um exemplo.

Opcionalmente, use `jids: ['5511999999999@s.whatsapp.net']`, `lids: ['123456789@lid']` ou
`chatIds: ['123456789@lid']`. `jids` exige o endereço completo, `lids` aceita o endereço com
`@lid` ou somente o ID, e `chatIds` aceita o endereço variável do webhook, que pode ser JID ou LID.
O campo `chatId` está presente no webhook; o que pode variar é seu valor. `remoteJid` e `lid`
podem estar ausentes.
As listas são alternativas (**OU**): basta corresponder a um identificador. Se quiser restringir
estritamente pelo UUID estável, configure apenas `conversationIds`.

O adapter considera `sender.jid`, `remoteJid`, `lid` e `chatId` após autenticar o webhook e
confirmar a identidade da mensagem persistida. Se necessário, consulta a conversa da mesma sessão
para resolver aliases PN/LID do contato. Não depende de `sender.id`, nome ou número parcial.
Falha nessa consulta retorna **503**, sem acionar o agente. Usuários não permitidos recebem
**200**, sem dispatch, download de áudio ou transcrição. Isso não bloqueia o contato no WhatsApp.

Omitir `allowedUsers` mantém o comportamento anterior (todos os contatos individuais).
`allowedUsers: {}` ou listas vazias não permitem ninguém.

### Mensagens de voz e transcrição

Áudio gravado diretamente no WhatsApp (PTT) chega como `type: 'audio'`, com `media.voice: true`.
O adapter fornece um anexo com download autenticado; normaliza o MIME sem parâmetros de codec e,
para voz sem MIME/nome, usa `audio/ogg` e `voice.ogg`. Não há conversão de formato.

**Receber o anexo não significa que o modelo ouviu o áudio.** Por padrão, o Mastra não inclui
áudio em `inlineMedia`. Há dois caminhos:

- **Modelo com suporte ao formato recebido:** configure `channels.inlineMedia` no consumidor,
  preservando os tipos já necessários, por exemplo:

  ```ts
  const channels = {
    adapters: { zappaz: adapter },
    inlineMedia: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'audio/*'],
  }
  ```

  Isso não adiciona suporte de áudio a um modelo que não o tenha. O modelo precisa aceitar
  também o codec/formato real (normalmente OGG/Opus em mensagens de voz).

- **Modelo somente de texto:** forneça `transcribeAudio`. O callback recebe
  `{ data: Buffer, mimeType, fileName?, voice, message }` e deve retornar `Promise<string>`.
  Conecte o seu serviço de speech-to-text; o adapter não escolhe provedor nem lê chaves de IA.

  Exemplo opcional com [OpenAIVoice do Mastra](https://mastra.ai/integrations/voice/openai)
  (instale `@mastra/voice-openai` no **consumidor** e configure `OPENAI_API_KEY`):

  ```ts
  import { Readable } from 'node:stream'
  import { OpenAIVoice } from '@mastra/voice-openai'

  const voice = new OpenAIVoice()
  const filetypes: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  }

  const adapter = createZappazAdapter({
    ...config,
    transcribeAudio: async ({ data, mimeType }) => {
      const filetype = filetypes[mimeType]
      if (!filetype) throw new Error('Formato de áudio não suportado pelo transcritor')
      return voice.listen(Readable.from([data]), { filetype })
    },
  })
  ```

  A transcrição vira texto da mensagem antes do dispatch e do agrupamento. O payload original e
  o anexo continuam disponíveis. Com esse caminho não é necessário adicionar áudio a `inlineMedia`.
  Retorno vazio, erro de transcrição ou falha de download retorna **503**, sem acionar o agente.
  Configure timeout no seu transcritor; ele executa durante a requisição do webhook e pode gerar
  custos externos. O limite de download continua sendo 25 MiB.

### Respostas a mensagens citadas

Ao usar “Responder” no WhatsApp, o adapter inclui um bloco identificado de **mensagem citada**
antes da mensagem atual. Preserva ID, remetente e texto da citação; mensagens citadas sem texto
recebem um marcador como `[audio]` ou `[image]`, sem inventar o conteúdo da mídia.

O snapshot `replyTo` persistido tem prioridade. Quando ausente, o adapter aceita
`payload.message.replyTo` do webhook autenticado (`id`, `senderId`, `type`, `text`), somente após
validar a identidade da mensagem atual. A citação normalizada fica em `message.raw.replyTo`.
O texto citado é limitado a 8.192 caracteres e continua presente com transcrição e agrupamento.
Não há download automático da mídia citada nem recuperação recursiva de outras citações.

### Qual identificador o Mastra usa?

O adapter identifica a conversa por `zappaz:<sessão em base64url>:<conversationId>`, mantendo
estabilidade quando o endereçamento muda entre PN e LID. O Mastra mapeia essa thread do canal para
uma thread interna, com UUID próprio por padrão. O dono da memória (`resourceId`) é, por padrão,
`zappaz:${message.author.userId}`; `author.userId` usa o JID do remetente persistido, ou
`conversation:<conversationId>` quando esse JID não está disponível. Esses IDs organizam contexto,
**não são uma lista de permissões**. `resolveResourceId` e `resolveThreadId` do Mastra customizam
esse mapeamento para novas threads; threads existentes mantêm os valores armazenados.

## Usar com Chat SDK diretamente

```ts
import { Chat } from 'chat'
import { createZappazAdapter } from '@zappaz/chat-adapter-zappaz'

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
`inbound-message.upsert` e configure o campo `secret` com o mesmo `webhookSecret` do adapter.
Se usar `humanPauseMs`, habilite também `outbound-message.upsert` e `messages.send`.
A Zappaz envia esse segredo automaticamente no header:

```json
{ "X-Zappaz-Webhook-Secret": "change-me-use-a-random-secret" }
```

O valor é o segredo puro, sem prefixo Bearer. Não configure esse header nos headers adicionais:
ele é reservado pela Zappaz. Não há assinatura HMAC do corpo nem fallback para `Authorization`.
Não use a API Key como segredo do webhook; a API REST usa `x-api-key` separadamente.

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

Para testar, envie texto ou mídia **de outro número** para a sessão. Mensagens enviadas pela própria
conta nunca iniciam execuções do agente; podem ativar a pausa humana quando configurada. Quando
terminar, desative o webhook; sem `allowedUsers`, o handler pode responder
a toda mensagem individual suportada recebida.

### Receber imagens, áudios e documentos

Imagens, áudios, documentos, vídeos e stickers acionam o mesmo handler de DM. O texto ou legenda
persistida fica em `message.text`; sem texto, usa-se `[image]`, `[audio]` etc. Os arquivos ficam em
`message.attachments`: imagens/stickers usam `image`, documentos usam `file`, e áudio/vídeo usam
`audio`/`video`. Cada anexo tem os metadados disponíveis e `fetchData()` para baixar os bytes:

```ts
bot.onDirectMessage(async (thread, message) => {
  for (const attachment of message.attachments) {
    if (attachment.type === 'image' && attachment.fetchData) {
      const bytes = await attachment.fetchData()
      // Encaminhe os bytes a um modelo com suporte a imagens ou processe-os aqui.
    }
  }
  await thread.post('Mensagem recebida!')
})
```

O download é sob demanda, autenticado internamente com `x-api-key`, usando a rota de mídia da
conversa na Zappaz. Não há URL pública nem credenciais nos anexos. Cada download tem timeout de
15 segundos e limite de 25 MiB, verificado também durante a leitura. Falhas de download são
propagadas a quem chamou `fetchData()`; não há retry automático. O webhook aceita a mensagem
antes desse download, portanto aceite não garante disponibilidade do arquivo.

Anexos também são disponibilizados no histórico e podem ser reidratados pelo Chat SDK após
serialização. O adapter não faz OCR ou descrição de imagens por conta própria: configure um
modelo multimodal e uma integração que consuma os anexos. `toAiMessages` do Chat SDK suporta
imagens e alguns arquivos de texto, mas não transcreve áudio nem interpreta PDF/vídeo automaticamente.
Baixe esses anexos com `fetchData()` e encaminhe-os ao serviço/modelo adequado no consumidor.

### Enviar arquivos e responder com citação

```ts
await thread.post({
  raw: 'Confira o documento',
  files: [{ data: Buffer.from(pdfBytes), filename: 'relatorio.pdf', mimeType: 'application/pdf' }],
})

await adapter.reply(thread.id, message.id, 'Resposta citando a mensagem original')
await adapter.reply(thread.id, message.id, {
  raw: 'Foto solicitada',
  files: [{ data: Buffer.from(imageBytes), filename: 'foto.png', mimeType: 'image/png' }],
})
```

Envios usam multipart na rota `/conversations/:conversationId/messages/media`. Aceitam até 10
arquivos por post, cada um de 1 byte a 25 MiB; `data` aceita Buffer, Blob ou ArrayBuffer.
O MIME informado ou inferido pela extensão seleciona imagem, áudio, vídeo ou documento; a Zappaz
valida os bytes e suas próprias políticas. URLs não são baixadas automaticamente pelo adapter.
Anexos de saída em `attachments` também são aceitos quando fornecem `data` binário.

Uma legenda curta acompanha o primeiro arquivo. Para áudio, o texto é enviado separadamente para
não ser descartado pelo backend. Texto longo é enviado em partes antes dos arquivos. Citações usam
o UUID interno, não o ID WhatsApp, e valem também para arquivos e textos divididos.

Os envios são sequenciais e não transacionais: uma falha pode ocorrer depois de algumas partes
terem sido enviadas. Não repita o post inteiro automaticamente. `postMessage()` e `reply()` retornam
o registro da **última** parte; edição/exclusão desse ID afetam apenas essa parte.
Use `adapter.postMessages(thread.id, conteudo, uuidCitadoOpcional)` para obter todos os registros.

### Agrupar mensagens antes de executar o agente

```ts
const adapter = createZappazAdapter({ ...config, debounceMs: 5000 })
```

Cada conversa tem seu lote. A cada mensagem suportada, o prazo é reiniciado; após a pausa, o
handler recebe uma única mensagem com os textos/legendas concatenados e todos os anexos. O ID,
autor e `raw` são os da última mensagem. Há flush automático aos 100 itens, 65.536 caracteres
ou após até 60 segundos de janela contínua. Os lotes de uma conversa executam sequencialmente.
Reenvios são deduplicados por ID no state por 5 minutos antes de entrar no buffer.

O buffer é **local e em memória**: reinícios perdem lotes pendentes e múltiplas instâncias não
compartilham o agrupamento. Use um processo persistente ou `waitUntil` com prazo suficiente;
não é uma fila durável. Não combine esse agrupamento com outro debounce do consumidor sem avaliar
o atraso adicional. Falhas do handler são registradas no logger, sem retry automático.
`disconnect()` descarta lotes pendentes e aguarda os já iniciados.

### Pausa para atendimento humano

```ts
const adapter = createZappazAdapter({ ...config, humanPauseMs: 5 * 60 * 1000 })

await adapter.pauseThread(threadId, 10 * 60 * 1000) // Pausa manual
await adapter.isThreadPaused(threadId)
await adapter.resumeThread(threadId)
```

Com a opção habilitada e os eventos de saída cadastrados, mensagens próprias persistidas que não
foram enviadas por este adapter pausam a conversa. Envios do bot são reconhecidos pelo
`clientRequestId` registrado no state **antes** da chamada à API. O DTO da API precisa preservar
esse campo. Outras integrações são consideradas atendimento humano. Eventos antigos não renovam
a pausa: o prazo considera `orderAt` da mensagem de saída.

O state do Chat SDK armazena a pausa e as marcas dos envios; use storage compartilhado e persistente
em produção. A pausa cancela lotes pendentes, solicita `abortTurn()` e bloqueia novos posts,
respostas citadas e edições até expirar ou ser removida. Entrada durante a pausa recebe 200 e não é
reexecutada automaticamente depois. A exclusão continua disponível. Métodos manuais requerem
adapter inicializado; funcionam também sem detecção automática configurada.

A pausa é best effort: uma requisição já em trânsito não pode ser desfeita e o consumidor precisa
respeitar cancelamento para interromper trabalho externo. Uma nova pausa não encurta uma pausa
mais longa já registrada; atualizações simultâneas entre processos não são uma transação global.

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
  bot. Eventos de saída não iniciam execuções; a detecção de atendimento humano é opcional.
- O texto vem do registro persistido. Mensagens removidas antes do processamento são ignoradas.
  Eventos de histórico/reenvios podem iniciar execuções quando ainda não deduplicados: o envelope
  atual não distingue sync de mensagem ao vivo.
- Envio, edição e exclusão para todos dependem das permissões e restrições do WhatsApp. Envios de
  texto desativam a assinatura naquele envio; mídia segue a política do endpoint da Zappaz.
- Histórico é retornado em ordem cronológica, com cursores opacos. O padrão é paginação para trás
  (`before`); `fetchMessages(threadId, { direction: 'forward', cursor })` usa `after`.
  Sem cursor, a API não oferece início direto pelo mais antigo: o adapter percorre páginas para
  trás e usa `boundaries.last` da página mais antiga para continuar para frente, sem inventar
  cursores. Essa busca inicial é limitada a 100 páginas e a um orçamento de 30 segundos verificado
  entre requisições; exceder o orçamento gera erro explícito, não histórico incompleto silencioso.
- Markdown é convertido para a formatação WhatsApp. Títulos viram negrito e links preservam texto
  e destino. O parser de entrada usa os limites de segurança de `BaseFormatConverter.parseIncoming`.
- Cada mensagem de texto tem **1–4096 caracteres**, não apenas espaços. Posts de até 65.536
  caracteres são divididos automaticamente, sem truncamento ou corte de pares UTF-16; a quebra
  prefere espaços/linhas. Estilos Markdown que atravessam partes podem perder formatação.
  `splitLongMessages: false` restaura o limite de 4096 por post. Edições continuam limitadas a 4096.
  `stream()` acumula até 65.536 caracteres e envia ao final, possivelmente em várias partes;
  cancelamento é conferido durante a acumulação e antes do envio.
- Requisições têm timeout de 15 segundos. Escritas não são repetidas automaticamente, nem após
  timeout/5xx, para evitar envios duplicados. Redirecionamentos HTTP são recusados.
- Logs de resolução/dispatch usam o logger do Chat SDK, sem incluir segredo, payload ou texto.

### Ainda sem suporte

Grupos, cards, botões, reações e digitação continuam sem suporte. Cards, reações e digitação
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
