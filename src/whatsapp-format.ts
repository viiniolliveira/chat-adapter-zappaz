export type WhatsAppTextPart =
  | { kind: 'text' | 'code'; offset: number; value: string }
  | { kind: 'link'; offset: number; value: string; href: string }
  | { kind: 'strong' | 'em' | 'del'; offset: number; children: WhatsAppTextPart[] }

const tokenPattern =
  /```([\s\S]+?)```|`([^`\r\n]+)`|\*([^\s*](?:[^*]*[^\s*])?)\*|_([^\s_](?:[^_]*[^\s_])?)_|~([^\s~](?:[^~]*[^\s~])?)~|https?:\/\/[^\s<>"'`]+/giu
const wordCharacter = /[\p{L}\p{N}]/u

function linkText(raw: string) {
  const closing = new Map([
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ])
  const excess = new Map<string, number>([
    [')', 0],
    [']', 0],
    ['}', 0],
  ])
  for (const character of raw) {
    const end = closing.get(character)
    if (end) excess.set(end, (excess.get(end) ?? 0) - 1)
    else if (excess.has(character)) excess.set(character, (excess.get(character) ?? 0) + 1)
  }
  let end = raw.length
  while (end) {
    const character = raw[end - 1]
    if (/[.,!?;:]/.test(character)) end--
    else if ((excess.get(character) ?? 0) > 0) {
      excess.set(character, (excess.get(character) ?? 0) - 1)
      end--
    } else break
  }
  return raw.slice(0, end)
}

export function parseWhatsAppText(text: string): WhatsAppTextPart[] {
  const parts: WhatsAppTextPart[] = []
  let cursor = 0
  for (const match of text.matchAll(tokenPattern)) {
    const offset = match.index
    if (offset > cursor)
      parts.push({ kind: 'text', offset: cursor, value: text.slice(cursor, offset) })
    const raw = match[0]
    cursor = offset + raw.length
    if (/^https?:\/\//i.test(raw)) {
      const value = linkText(raw)
      let destination: URL | null = null
      try {
        destination = new URL(value)
      } catch {
        /* Invalid URLs stay literal text. */
      }
      if (destination && !destination.username && !destination.password) {
        parts.push({ kind: 'link', offset, value, href: destination.href })
        if (value.length < raw.length)
          parts.push({
            kind: 'text',
            offset: offset + value.length,
            value: raw.slice(value.length),
          })
      } else parts.push({ kind: 'text', offset, value: raw })
      continue
    }
    const marker = raw[0]
    const before = text[offset - 1] ?? ''
    const after = text[cursor] ?? ''
    const code = match[1] ?? match[2]
    // Do not reinterpret markers inside words, URLs, or Markdown-style doubled delimiters.
    const valid =
      code !== undefined
        ? before !== '`' && after !== '`'
        : !wordCharacter.test(before) &&
          !wordCharacter.test(after) &&
          before !== marker &&
          after !== marker
    if (!valid) {
      parts.push({ kind: 'text', offset, value: raw })
      continue
    }
    if (code !== undefined) parts.push({ kind: 'code', offset, value: code })
    else {
      const value = match[3] ?? match[4] ?? match[5]
      parts.push({
        kind: marker === '*' ? 'strong' : marker === '_' ? 'em' : 'del',
        offset,
        children: parseWhatsAppText(value),
      })
    }
  }
  if (cursor < text.length) parts.push({ kind: 'text', offset: cursor, value: text.slice(cursor) })
  return parts
}
