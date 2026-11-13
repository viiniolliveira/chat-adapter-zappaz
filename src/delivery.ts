import { ValidationError } from '@chat-adapter/shared'
import type { FileUpload } from 'chat'

/** Preserve every UTF-16 code unit without cutting a surrogate pair. */
export function splitText(text: string): string[] {
  const chunks: string[] = []
  while (text.length > 4096) {
    let end = 4096
    const boundary = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1))
    if (boundary >= 2048) end = boundary + 1
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
    chunks.push(text.slice(0, end))
    text = text.slice(end)
  }
  if (text) chunks.push(text)
  // A whitespace-only tail cannot be sent on its own: move the boundary earlier.
  if (chunks.length > 1 && !chunks.at(-1)?.trim()) {
    const tail = chunks.pop() ?? ''
    const previous = chunks.pop() ?? ''
    const combined = previous + tail
    let end = combined.length - 4096
    if (end < 1) end = 1
    const code = combined.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end++
    chunks.push(combined.slice(0, end), combined.slice(end))
  }
  if (chunks.some((chunk) => !chunk.trim() || chunk.length > 4096))
    throw new ValidationError('zappaz', 'Text cannot be split into valid nonblank messages')
  return chunks
}

export function prepareFile(file: FileUpload) {
  const size = file.data instanceof Blob ? file.data.size : file.data.byteLength
  if (!size || size > 25 * 1024 * 1024)
    throw new ValidationError('zappaz', 'Files must contain 1 byte to 25 MiB')
  if (!file.filename.trim()) throw new ValidationError('zappaz', 'A filename is required')
  const extension = file.filename.split('.').at(-1)?.toLowerCase() ?? ''
  const inferred: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
  }
  const mimeType =
    (
      file.mimeType ||
      (file.data instanceof Blob && file.data.type) ||
      (Object.hasOwn(inferred, extension) && inferred[extension]) ||
      'application/octet-stream'
    )
      .split(';')[0]
      ?.trim()
      .toLowerCase() || 'application/octet-stream'
  const prefix = mimeType.split('/')[0]
  const kind = prefix === 'image' || prefix === 'video' || prefix === 'audio' ? prefix : 'document'
  return { file, mimeType, kind }
}
