import { BaseFormatConverter, type Content, type Paragraph, type Root } from 'chat'
import { parseWhatsAppText, type WhatsAppTextPart } from './whatsapp-format.ts'

function incoming(parts: WhatsAppTextPart[]): Paragraph['children'] {
  return parts.map((part) => {
    switch (part.kind) {
      case 'text':
        return { type: 'text', value: part.value }
      case 'code':
        return { type: 'inlineCode', value: part.value }
      case 'link':
        return { type: 'link', url: part.href, children: [{ type: 'text', value: part.value }] }
      case 'strong':
        return { type: 'strong', children: incoming(part.children) }
      case 'em':
        return { type: 'emphasis', children: incoming(part.children) }
      case 'del':
        return { type: 'delete', children: incoming(part.children) }
      default:
        throw new Error('Unsupported WhatsApp text part')
    }
  })
}

export class ZappazFormatConverter extends BaseFormatConverter {
  toAst(value: string): Root {
    return {
      type: 'root',
      children: [{ type: 'paragraph', children: incoming(parseWhatsAppText(value)) }],
    }
  }

  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) => this.renderNode(node))
  }

  private renderNode(node: Content): string {
    const children = () =>
      'children' in node ? node.children.map((child) => this.renderNode(child)).join('') : ''
    switch (node.type) {
      case 'strong':
        return `*${children()}*`
      case 'emphasis':
        return `_${children()}_`
      case 'delete':
        return `~${children()}~`
      case 'inlineCode':
        return `\`${node.value}\``
      case 'code':
        return `\`\`\`\n${node.value}\n\`\`\``
      case 'link':
        return children() === node.url ? node.url : `${children()} (${node.url})`
      case 'image':
        return node.alt ? `${node.alt} (${node.url})` : node.url
      case 'break':
        return '\n'
      case 'heading':
        return `*${children()}*`
      case 'blockquote':
        return children()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      case 'list':
        return this.renderList(node, 0, (child) => this.renderNode(child), '-')
      case 'thematicBreak':
        return '---'
      default:
        return this.defaultNodeToText(node, (child) => this.renderNode(child))
    }
  }
}
