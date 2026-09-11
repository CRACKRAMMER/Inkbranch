import type { Blockquote, Paragraph, Root } from 'mdast'
import { visit } from 'unist-util-visit'

/**
 * GitHub-style alerts.
 *
 *   > [!NOTE]
 *   > Useful information.
 *
 * Rewritten into the same markup as the `:::note` directive, so a document
 * that uses either form renders identically and there is one set of styles.
 */

interface AlertDefinition {
  tone: string
  label: string
  defaultTitle?: string
}

const ALERTS: Record<string, AlertDefinition> = {
  NOTE: { tone: 'note', label: 'Note' },
  INFO: { tone: 'note', label: 'Info' },
  TIP: { tone: 'tip', label: 'Tip' },
  SUCCESS: { tone: 'tip', label: 'Success' },
  IMPORTANT: { tone: 'danger', label: 'Important' },
  WARNING: { tone: 'warning', label: 'Warning' },
  CAUTION: { tone: 'danger', label: 'Caution' },
  DANGER: { tone: 'danger', label: 'Danger' },
  ERROR: { tone: 'danger', label: 'Error' },
  QUESTION: { tone: 'note', label: 'Question' },
  QUOTE: { tone: 'note', label: 'Quote' },
  EXAMPLE: { tone: 'note', label: 'Example' },
}

/** `[!NOTE]` optionally followed by a custom title: `[!NOTE] Be careful`. */
const ALERT_PATTERN = /^\[!([A-Za-z]+)\]\s*(.*)$/

export function remarkAlerts() {
  return (tree: Root): void => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0]
      if (!first || first.type !== 'paragraph') return

      const marker = readMarker(first)
      if (!marker) return

      const definition = ALERTS[marker.kind]
      // An unknown marker is a normal blockquote that happens to start with
      // brackets; leave it rendered as one.
      if (!definition) return

      const title = marker.rest || definition.label

      // Drop the marker line from the quoted content.
      stripFirstLine(first)
      if (isEmpty(first)) {
        node.children.shift()
      }
      if (node.children.length === 0) {
        // A callout with no body other than its title still needs a body node,
        // or `hName` on the blockquote would render an empty aside.
        node.children.push({ type: 'paragraph', children: [] })
      }

      const data = node.data ?? (node.data = {})
      data.hName = 'aside'
      data.hProperties = {
        className: [`md-callout md-callout--${definition.tone}`],
        role: 'note',
      }

      node.children.unshift({
        type: 'paragraph',
        data: {
          hName: 'p',
          hProperties: { className: ['md-callout__title'] },
        },
        children: [{ type: 'text', value: title }],
      } as Paragraph)
    })
  }
}

interface Marker {
  kind: string
  rest: string
}

/** Read `[!NOTE]` from the first text node of a paragraph. */
function readMarker(paragraph: Paragraph): Marker | null {
  const first = paragraph.children[0]
  if (!first || first.type !== 'text') return null

  const match = ALERT_PATTERN.exec(first.value.split('\n')[0] ?? '')
  if (!match?.[1]) return null

  return { kind: match[1].toUpperCase(), rest: (match[2] ?? '').trim() }
}

/** Remove the marker line, keeping any text that followed it. */
function stripFirstLine(paragraph: Paragraph): void {
  const first = paragraph.children[0]
  if (!first || first.type !== 'text') return

  const newlineIndex = first.value.indexOf('\n')
  if (newlineIndex === -1) {
    // The marker was the whole paragraph.
    paragraph.children.shift()
    return
  }

  first.value = first.value.slice(newlineIndex + 1).replace(/^\s+/, '')
}

function isEmpty(paragraph: Paragraph): boolean {
  return (
    paragraph.children.length === 0 ||
    paragraph.children.every(
      (child) => child.type === 'text' && child.value.trim() === '',
    )
  )
}
