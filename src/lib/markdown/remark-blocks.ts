import type { BlockContent, DefinitionContent, Root } from 'mdast'
import type { ContainerDirective, LeafDirective, TextDirective } from 'mdast-util-directive'
import { visit } from 'unist-util-visit'

/**
 * Custom block syntax.
 *
 * Everything here maps a directive onto plain HTML elements with classes.
 * No React components are involved, which is what keeps rich articles shipping
 * zero extra client JavaScript — the interactive parts (tabs, Mermaid) are
 * picked up by one delegated client component after hydration.
 *
 * Syntax:
 *
 *   :::note              :::callout{title="Why"}
 *   Body                 Body
 *   :::                  :::
 *
 *   ::::tabs             :::file-tree
 *   :::tab[Label]        src/index.ts
 *   Body                 src/lib/db.ts
 *   :::                  :::
 *   ::::
 *
 *   Press :kbd[Ctrl] + :kbd[S]
 */

type DirectiveNode = ContainerDirective | LeafDirective | TextDirective

/** Callout kinds, mapped to a colour token and a default label. */
const CALLOUT_KINDS: Record<string, { label: string; tone: string }> = {
  note: { label: 'Note', tone: 'note' },
  info: { label: 'Info', tone: 'note' },
  tip: { label: 'Tip', tone: 'tip' },
  success: { label: 'Success', tone: 'tip' },
  warning: { label: 'Warning', tone: 'warning' },
  caution: { label: 'Caution', tone: 'warning' },
  danger: { label: 'Danger', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },
  important: { label: 'Important', tone: 'danger' },
  callout: { label: '', tone: 'note' },
  details: { label: 'Details', tone: 'details' },
}

export function remarkBlocks() {
  return (tree: Root): void => {
    visit(tree, (node) => {
      if (
        node.type !== 'containerDirective' &&
        node.type !== 'leafDirective' &&
        node.type !== 'textDirective'
      ) {
        return
      }
      transform(node as DirectiveNode)
    })

    // Tabs need a second pass: the first pass converted every `tab` child, but
    // the wrapper must know how many tabs it has to build its toolbar.
    let tabGroup = 0
    visit(tree, 'containerDirective', (node: ContainerDirective) => {
      if (node.name !== 'tabs') return
      buildTabs(node, tabGroup++)
    })
  }
}

function transform(node: DirectiveNode): void {
  const name = node.name.toLowerCase()

  if (node.type === 'textDirective') {
    // `:kbd[Ctrl]` and friends. Anything else is left alone and renders as
    // literal text, which is the least surprising outcome for a typo.
    if (name === 'kbd' || name === 'key') {
      node.data = {
        ...node.data,
        hName: 'kbd',
        hProperties: { className: ['md-kbd'] },
      }
    } else if (name === 'abbr' || name === 'mark' || name === 'sup' || name === 'sub') {
      node.data = { ...node.data, hName: name }
    }
    return
  }

  if (node.type === 'leafDirective') {
    if (name === 'video' || name === 'audio') {
      const src = readAttribute(node, 'src')
      if (!src) return
      const poster = readAttribute(node, 'poster')
      node.data = {
        ...node.data,
        hName: name,
        hProperties: {
          className: [`md-${name}`],
          src,
          controls: true,
          preload: 'metadata',
          ...(name === 'video' && poster ? { poster } : {}),
        },
      }
      // A media element takes no children.
      node.children = []
      return
    }

    if (name === 'embed' || name === 'iframe') {
      const src = readAttribute(node, 'src')
      if (!src) return
      // The renderer's sanitiser rejects an iframe whose origin is not on the
      // allow-list, so a bad `src` degrades to nothing rather than to an
      // injection primitive.
      node.data = {
        ...node.data,
        hName: 'iframe',
        hProperties: {
          className: ['md-embed'],
          src,
          loading: 'lazy',
          allowFullScreen: true,
          referrerPolicy: 'strict-origin-when-cross-origin',
          title: readAttribute(node, 'title') ?? 'Embedded content',
        },
      }
      node.children = []
      return
    }

    if (name === 'figure') {
      node.data = { ...node.data, hName: 'figure', hProperties: { className: ['md-figure'] } }
      return
    }
  }

  if (node.type === 'containerDirective') {
    if (name === 'tab') {
      // `takeLabel` runs unconditionally: even when an explicit attribute
      // wins, the label paragraph still has to come out of the body.
      const bracketed = takeLabel(node)
      const label = readAttribute(node, 'label') ?? bracketed ?? 'Tab'
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: {
          className: ['md-tab'],
          dataTabLabel: label,
        },
      }
      return
    }

    if (name === 'file-tree') {
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: { className: ['md-file-tree'], role: 'img' },
      }
      return
    }

    if (name === 'columns' || name === 'grid') {
      const columns = readAttribute(node, 'columns') ?? '2'
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: {
          className: ['md-columns'],
          style: `--md-columns:${safeColumnCount(columns)}`,
        },
      }
      return
    }

    const kind = CALLOUT_KINDS[name]
    if (!kind) return

    if (kind.tone === 'details') {
      const bracketed = takeLabel(node)
      const summary = readAttribute(node, 'title') ?? bracketed ?? kind.label
      node.data = {
        ...node.data,
        hName: 'details',
        hProperties: { className: ['md-details'] },
      }
      // `summary` must be the first child for `<details>` to have a toggle.
      node.children.unshift(paragraph('summary', {}, [text(summary)]))
      return
    }

    const bracketed = takeLabel(node)
    const title = readAttribute(node, 'title') ?? bracketed ?? kind.label
    node.data = {
      ...node.data,
      hName: 'aside',
      hProperties: {
        className: [`md-callout md-callout--${kind.tone}`],
        // `role="note"` lets a screen reader announce the aside as an aside
        // rather than as a generic container.
        role: 'note',
      },
    }
    node.children.unshift(
      paragraph('p', { className: ['md-callout__title'] }, [text(title)]),
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  Tabs                                                                       */
/* -------------------------------------------------------------------------- */

function buildTabs(node: ContainerDirective, group: number): void {
  const labels: string[] = []

  for (const child of node.children) {
    if (child.type !== 'containerDirective' || child.name !== 'tab') continue
    const data = child.data as { hProperties?: Record<string, unknown> } | undefined
    const label = data?.hProperties?.dataTabLabel
    labels.push(typeof label === 'string' ? label : 'Tab')
  }

  if (labels.length === 0) return

  const toolbar =
    `<div class="md-tabs__list" role="tablist">` +
    labels
      .map(
        (label, index) =>
          `<button type="button" role="tab" class="md-tabs__tab" id="tab-${group}-${index}" ` +
          `data-tab-index="${index}" aria-selected="${index === 0 ? 'true' : 'false'}" ` +
          `tabindex="${index === 0 ? '0' : '-1'}">${escapeHtml(label)}</button>`,
      )
      .join('') +
    `</div>`

  node.data = {
    ...node.data,
    hName: 'div',
    hProperties: { className: ['md-tabs'], dataTabs: String(labels.length) },
  }

  node.children.unshift({ type: 'html', value: toolbar })
}

/* -------------------------------------------------------------------------- */
/*  Attribute helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read a directive attribute.
 * `:::note{title="Careful"}` and `::video[Watch]{src="…"}` both land here.
 */
function readAttribute(node: DirectiveNode, key: string): string | null {
  const attributes = node.attributes ?? {}
  const value = attributes[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Take the bracketed label: `:::tab[Install]` → `Install`.
 *
 * Two details matter, and both are load-bearing:
 *
 * - `remark-directive` marks the label paragraph with `data.directiveLabel`.
 *   Testing that flag — rather than assuming the first paragraph is the label —
 *   is what stops `:::warning` followed by its body from adopting the body's
 *   first paragraph as its title.
 * - The paragraph stays in the children after parsing, so it must be removed
 *   here or the label renders a second time as body text. Hence "take", not
 *   "read".
 */
function takeLabel(node: ContainerDirective): string | null {
  const index = node.children.findIndex(isDirectiveLabel)
  if (index === -1) return null

  const [label] = node.children.splice(index, 1)
  // The flag and the node type are checked separately because `findIndex` does
  // not narrow what `splice` hands back.
  if (!label || label.type !== 'paragraph') return null

  const text = label.children
    .map((child) => ('value' in child && typeof child.value === 'string' ? child.value : ''))
    .join('')
    .trim()
  return text || null
}

function isDirectiveLabel(child: BlockContent | DefinitionContent): boolean {
  return (
    child.type === 'paragraph' &&
    (child.data as { directiveLabel?: boolean } | undefined)?.directiveLabel === true
  )
}

function safeColumnCount(value: string): string {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 4) return '2'
  return String(parsed)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* -------------------------------------------------------------------------- */
/*  mdast node builders                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A paragraph that renders as `tagName`.
 *
 * `mdast-util-to-hast` honours `data.hName`, so this is the supported way to
 * emit an element that mdast has no node type for — without splicing raw HTML
 * strings into the tree, which would then have to survive sanitisation.
 */
function paragraph(
  tagName: string,
  properties: Record<string, unknown>,
  children: MdastContent[],
): MdastContent {
  return {
    type: 'paragraph',
    data: { hName: tagName, hProperties: properties },
    children,
  } as unknown as MdastContent
}

function text(value: string): MdastContent {
  return { type: 'text', value } as unknown as MdastContent
}

type MdastContent = ContainerDirective['children'][number]
