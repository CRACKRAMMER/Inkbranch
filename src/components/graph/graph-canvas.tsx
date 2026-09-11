'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { layoutGraph, type LayoutEdge } from '@/lib/graph/layout'
import type { GraphNode } from '@/lib/graph/graph'

/**
 * The knowledge graph, drawn.
 *
 * Canvas rather than SVG. At the page's default ceiling of 250 nodes and
 * several hundred edges, an SVG graph is 800+ elements that the browser
 * re-styles, re-lays-out and repaints as a tree on every pointer move — and
 * hover highlighting means a pointer move touches most of them. Canvas is one
 * element and a redraw that costs the same whatever the graph looks like.
 *
 * The trade is that canvas is opaque to assistive technology and to the
 * keyboard, which is a real loss and is paid for explicitly rather than
 * ignored: the canvas is `aria-hidden`, and `GraphExplorer` renders the same
 * graph as a navigable list of links beside it. A screen reader user and a
 * keyboard user get the documents and their connections; a mouse user gets the
 * picture. Neither gets a degraded version of the other.
 *
 * Nothing here animates. The layout is solved once and drawn once, so
 * `prefers-reduced-motion` has nothing to suppress — which is a better answer
 * than honouring it by disabling an animation the page did not need.
 */

/** Radius of a node with no neighbours, before degree is accounted for. */
const MIN_RADIUS = 2.5

/** Radius added per sqrt(degree), so a hub is bigger without dwarfing a leaf. */
const RADIUS_PER_DEGREE = 2.2

const MAX_RADIUS = 13

/** How many of the best-connected nodes are labelled without being hovered. */
const ALWAYS_LABELLED = 18

/** Pointer slack, in pixels, for selecting a node. */
const HIT_SLACK = 6

/**
 * How far the pointer may travel between press and release and still count as
 * a click rather than a drag.
 *
 * Four pixels is about the wobble of a deliberate click on a trackpad. Above
 * it, the reader was moving the node.
 */
const CLICK_SLOP = 4

interface ThemeColors {
  ink: string
  inkMuted: string
  inkSubtle: string
  line: string
  brand: string
  canvas: string
}

const FALLBACK_COLORS: ThemeColors = {
  ink: '#1a1a1a',
  inkMuted: '#666',
  inkSubtle: '#999',
  line: '#ddd',
  brand: '#8a5a20',
  canvas: '#ffffff',
}

/**
 * Read the theme tokens off the document.
 *
 * Read rather than hard-coded so the canvas uses the same OKLCH values as the
 * rest of the site and follows the dark-mode class for free. Read at draw time
 * rather than captured once, because the theme can change while the page is
 * open and a canvas is a snapshot — it will not repaint itself.
 *
 * The fallbacks exist for the server-side render pass and for the moment before
 * the stylesheet applies, when the custom properties are still empty strings.
 */
function readColors(): ThemeColors {
  if (typeof window === 'undefined') return FALLBACK_COLORS

  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback

  return {
    ink: read('--color-ink', FALLBACK_COLORS.ink),
    inkMuted: read('--color-ink-muted', FALLBACK_COLORS.inkMuted),
    inkSubtle: read('--color-ink-subtle', FALLBACK_COLORS.inkSubtle),
    line: read('--color-line', FALLBACK_COLORS.line),
    brand: read('--color-brand', FALLBACK_COLORS.brand),
    canvas: read('--color-canvas', FALLBACK_COLORS.canvas),
  }
}

/**
 * Hue for a node, from the rarest tag it carries.
 *
 * `node.tags` arrives rarest-first from the server, so `tags[0]` is the most
 * distinctive thing about the document rather than whichever tag it happened to
 * list first. Hashed from the name rather than looked up, because the graph
 * payload carries names and not slug/colour pairs — and the hue only ever
 * distinguishes neighbouring dots, so a hash is enough.
 *
 * A tag node carries its own slug as its only tag, so it lands on the same hue
 * as the documents carrying it: the square and the circles around it are the
 * same colour because they are the same subject.
 */
function nodeHue(node: GraphNode): number {
  const key = node.tags[0] ?? node.type
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 360
}

function radiusFor(degree: number): number {
  return Math.min(MAX_RADIUS, MIN_RADIUS + Math.sqrt(degree) * RADIUS_PER_DEGREE)
}

export interface GraphCanvasProps {
  nodes: readonly GraphNode[]
  edges: readonly LayoutEdge[]
  /** Called when a node is activated by click or keyboard. */
  onOpen: (node: GraphNode) => void
  className?: string
}

export function GraphCanvas({ nodes, edges, onOpen, className }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)

  /**
   * Where each node currently sits. Held in a ref, not state: it changes on
   * every pointer move during a drag, and re-rendering the component sixty
   * times a second to move a circle is work the canvas draw already does.
   */
  const positionsRef = useRef<{ x: number; y: number }[]>([])

  /** The settled layout, used as the starting point when a drag re-runs it. */
  const settledRef = useRef<{ x: number; y: number }[] | null>(null)

  /** Cancels a queued animation frame from a previous drag. */
  const frameRef = useRef<number | null>(null)

  /** Where the current press landed, for telling a click from a drag. */
  const pressRef = useRef<{ index: number; x: number; y: number } | null>(null)

  /**
   * Neighbours of each node, as a set of indices.
   *
   * Built once per graph rather than per hover: highlighting is the only
   * interaction on this page that a reader uses repeatedly, and rebuilding
   * adjacency on every pointer move would put an O(edges) loop inside a handler
   * that fires hundreds of times a second.
   */
  const adjacency = useMemo(() => {
    const map = new Map<number, Set<number>>()
    for (const edge of edges) {
      const from = map.get(edge.source) ?? new Set<number>()
      from.add(edge.target)
      map.set(edge.source, from)

      const to = map.get(edge.target) ?? new Set<number>()
      to.add(edge.source)
      map.set(edge.target, to)
    }
    return map
  }, [edges])

  /** The nodes whose labels are always drawn — the best connected ones. */
  const labelled = useMemo(() => {
    const ranked = nodes
      .map((node, index) => ({ index, degree: node.degree }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, ALWAYS_LABELLED)
    return new Set(ranked.map((entry) => entry.index))
  }, [nodes])

  /* ---------------------------------------------------------------------- */
  /*  Layout                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!size || nodes.length === 0) return

    const laidOut = layoutGraph(
      nodes.map((node) => ({ id: node.id, degree: node.degree })),
      edges,
      { width: size.width, height: size.height, initial: settledRef.current ?? undefined },
    )

    const points = laidOut.map((node) => ({ x: node.x, y: node.y }))
    settledRef.current = points
    positionsRef.current = points
  }, [nodes, edges, size])

  /* ---------------------------------------------------------------------- */
  /*  Sizing                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // `ResizeObserver` rather than a window resize listener: the canvas is
    // inside a grid cell, so it can change size when the window has not — a
    // sidebar collapsing, a filter panel opening.
    const observer = new ResizeObserver((records) => {
      const { width, height } = records[0]?.contentRect ?? { width: 0, height: 0 }
      // A zero measurement is the element being unmounted or hidden, not a
      // canvas anyone can see; sizing to it would throw away a good layout.
      if (width > 0 && height > 0) setSize({ width, height })
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  /* ---------------------------------------------------------------------- */
  /*  Drawing                                                               */
  /* ---------------------------------------------------------------------- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const positions = positionsRef.current
    if (!canvas || !container || !size || positions.length !== nodes.length) return

    const context = canvas.getContext('2d')
    if (!context) return

    const colors = readColors()
    const ratio = window.devicePixelRatio || 1

    // Sized in device pixels and scaled down, so the drawing is sharp on a
    // retina display rather than being a 1x bitmap stretched to 2x.
    const pixelWidth = Math.round(size.width * ratio)
    const pixelHeight = Math.round(size.height * ratio)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)

    const focus = dragging ?? hovered
    const neighbours = focus === null ? null : (adjacency.get(focus) ?? new Set<number>())

    /* Edges. */
    context.lineWidth = 1
    for (const edge of edges) {
      const from = positions[edge.source]
      const to = positions[edge.target]
      if (!from || !to) continue

      const touched =
        neighbours !== null &&
        (edge.source === focus ||
          edge.target === focus ||
          (neighbours.has(edge.source) && neighbours.has(edge.target)))

      // A hairline at low contrast when nothing is focused, because the shape
      // of the whole graph is the point. When something is focused, the edges
      // that have nothing to do with it drop to a fraction of that again.
      context.strokeStyle = colors.line
      context.globalAlpha = focus === null ? 0.9 : touched ? 1 : 0.15

      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.stroke()
    }

    /* Nodes. */
    for (let index = 0; index < nodes.length; index += 1) {
      const position = positions[index]
      const node = nodes[index]
      if (!position || !node) continue

      const isFocus = index === focus
      const isNeighbour = neighbours?.has(index) ?? false
      const dimmed = focus !== null && !isFocus && !isNeighbour

      context.globalAlpha = dimmed ? 0.2 : 1
      context.fillStyle = isFocus
        ? colors.brand
        : `oklch(${node.type === 'note' ? '62%' : '48%'} 0.09 ${nodeHue(node)})`

      const radius = radiusFor(node.degree)

      context.beginPath()
      if (node.type === 'tag') {
        /*
         * A square, because a tag is a different kind of thing from a document
         * and the picture has to say so somewhere. Shape rather than a second
         * colour: hue is already spoken for — it is how a node shows which tag
         * it belongs to — and a reader who cannot separate two hues would have
         * no way at all to tell the two kinds apart. A square against a circle
         * survives at any radius, at any contrast, in any palette.
         */
        context.rect(position.x - radius, position.y - radius, radius * 2, radius * 2)
      } else {
        context.arc(position.x, position.y, radius, 0, Math.PI * 2)
      }
      context.fill()

      // A ring on the hovered node, so the target of a click is unambiguous
      // even when it overlaps its neighbours. `stroke` re-traces the path just
      // filled, so it follows whichever shape was drawn without a second branch.
      if (isFocus) {
        context.strokeStyle = colors.canvas
        context.lineWidth = 1.5
        context.stroke()
      }
    }

    /* Labels. */
    context.globalAlpha = 1
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.textBaseline = 'middle'
    context.textAlign = 'left'

    for (let index = 0; index < nodes.length; index += 1) {
      const position = positions[index]
      if (!position) continue

      const isFocus = index === focus
      const isNeighbour = neighbours?.has(index) ?? false
      // Labelling every node in a 250-node graph produces a grey rectangle of
      // overlapping text. The best-connected nodes are labelled always, because
      // they are the landmarks; everything else is labelled when it is the
      // thing the pointer is on or next to.
      if (!isFocus && !isNeighbour && !(focus === null && labelled.has(index))) continue

      const node = nodes[index]
      if (!node) continue
      const radius = radiusFor(node.degree)

      // A tag is labelled the way the tag page labels it, so the word on the
      // canvas and the heading it links to are the same word.
      const label = node.type === 'tag' ? `#${node.title}` : node.title

      context.globalAlpha = focus !== null && !isFocus && !isNeighbour ? 0.2 : 1
      context.fillStyle = isFocus ? colors.ink : colors.inkMuted
      context.fillText(truncate(label, 28), position.x + radius + 4, position.y)
    }

    context.globalAlpha = 1
  }, [adjacency, dragging, edges, hovered, labelled, nodes, size])

  useEffect(() => {
    draw()
  }, [draw])

  /* Redraw when the theme flips — the canvas is a snapshot, not a live view. */
  useEffect(() => {
    const observer = new MutationObserver(draw)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [draw])

  /* ---------------------------------------------------------------------- */
  /*  Interaction                                                           */
  /* ---------------------------------------------------------------------- */

  /** The node nearest a point, within its own radius plus a little slack. */
  const nodeAt = useCallback(
    (x: number, y: number): number | null => {
      const positions = positionsRef.current
      let best: number | null = null
      let bestDistance = Infinity

      for (let index = 0; index < positions.length; index += 1) {
        const position = positions[index]
        if (!position) continue

        const distance = Math.hypot(position.x - x, position.y - y)
        const reach = radiusFor(nodes[index]?.degree ?? 0) + HIT_SLACK
        // Nearest-wins rather than first-wins: overlapping dots are common in a
        // dense cluster, and the one under the pointer is the one meant.
        if (distance <= reach && distance < bestDistance) {
          best = index
          bestDistance = distance
        }
      }

      return best
    },
    [nodes],
  )

  /** Canvas coordinates for a pointer event, accounting for CSS scaling. */
  const pointOf = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  /**
   * Re-solve the layout with one node pinned, at most once per frame.
   *
   * Dragging must feel immediate. Re-running the solver on every `pointermove`
   * would queue several solves for a single frame on a high-polling-rate mouse,
   * so the work is coalesced into one call per animation frame and the pending
   * call is cancelled when a newer one arrives.
   */
  const scheduleDrag = useCallback(
    (index: number, x: number, y: number) => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)

      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        if (!size) return

        const laidOut = layoutGraph(
          nodes.map((node) => ({ id: node.id, degree: node.degree })),
          edges,
          {
            width: size.width,
            height: size.height,
            initial: positionsRef.current,
            // Fewer iterations while dragging: the graph is already near
            // settled, so this is a local correction rather than a fresh solve,
            // and it has to fit in a frame.
            iterations: 60,
            pinned: { index, x, y },
          },
        )

        positionsRef.current = laidOut.map((node) => ({ x: node.x, y: node.y }))
        draw()
      })
    },
    [draw, edges, nodes, size],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = pointOf(event)
      const index = nodeAt(x, y)
      if (index === null) return

      // Where the press landed, so `handlePointerUp` can tell a click from a
      // drag. Recorded whether or not this turns into a drag.
      pressRef.current = { index, x, y }

      // Capture, so a fast drag that leaves the canvas still delivers moves to
      // it — otherwise the node sticks where the pointer left the element.
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(index)
    },
    [nodeAt, pointOf],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = pointOf(event)

      if (dragging !== null) {
        scheduleDrag(dragging, x, y)
        return
      }

      const index = nodeAt(x, y)
      setHovered((current) => (current === index ? current : index))
    },
    [dragging, nodeAt, pointOf, scheduleDrag],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = pointOf(event)
      const index = nodeAt(x, y)

      if (dragging !== null) {
        event.currentTarget.releasePointerCapture(event.pointerId)
        setDragging(null)
        settledRef.current = positionsRef.current

        /*
         * A drag that barely moved is a click with a shaky hand.
         *
         * The threshold is what makes dragging usable: a pointer that travels
         * four pixels between press and release is a reader trying to grab a
         * node, not a reader asking to open the document, and navigating on
         * that would make the node impossible to pick up. The distance is
         * measured from where the press landed on *this* node, so a drag that
         * wanders away and comes back does open the document — which is what
         * the reader meant.
         */
        const press = pressRef.current
        const moved = press ? Math.hypot(x - press.x, y - press.y) : Infinity
        if (index === dragging && moved <= CLICK_SLOP) {
          const node = nodes[dragging]
          if (node) onOpen(node)
        }
        return
      }

      if (index !== null) {
        const node = nodes[index]
        if (node) onOpen(node)
      }
    },
    [dragging, nodeAt, nodes, onOpen, pointOf],
  )

  /**
   * A pointer leaving the canvas mid-drag.
   *
   * Pointer capture keeps delivering moves outside the element, so this only
   * fires for a genuine exit — and it must not treat that as a click.
   */
  const handlePointerCancel = useCallback(() => {
    setDragging(null)
    settledRef.current = positionsRef.current
  }, [])

  return (
    <div ref={containerRef} className={className}>
      <canvas
        ref={canvasRef}
        // The accessible representation of this graph is the list in
        // `GraphExplorer`. A canvas has no content to announce, so anything it
        // claimed to say would be a worse version of that list.
        aria-hidden="true"
        style={{ width: '100%', height: '100%', display: 'block' }}
        className={dragging === null ? 'cursor-pointer' : 'cursor-grabbing'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setHovered(null)}
      />
    </div>
  )
}

/**
 * Cut a label to a length, on a word boundary where there is one nearby.
 *
 * Grapheme-cluster aware via `Intl.Segmenter`, which is what stops a label
 * ending in half an emoji or a lone combining mark — both of which render as a
 * replacement character and look like a bug.
 */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value

  const separator = '…'
  const segments = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    (part) => part.segment,
  )

  const cut = segments.slice(0, limit - 1).join('')
  const lastSpace = cut.lastIndexOf(' ')

  return `${lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut}${separator}`
}
