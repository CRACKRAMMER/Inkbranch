'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

import type { GraphNode, GraphNodeKind, KnowledgeGraph } from '@/lib/graph/graph'
import { cn } from '@/lib/utils/cn'

/**
 * The knowledge graph page, as an island.
 *
 * Three things are deliberately lazy here, and each one is a separate reason:
 *
 * 1. **The payload.** Nothing is fetched until this component mounts, so
 *    arriving at `/graph` and immediately leaving costs one HTML response and
 *    no graph query. The server render of this page does no work at all.
 * 2. **The drawing code.** `GraphCanvas` — and the layout solver it pulls in —
 *    is a `next/dynamic` import, so it lands in its own chunk. The main bundle
 *    for this page is this file, React, and a `fetch`.
 * 3. **The solver run.** It happens in an effect, after the canvas is mounted
 *    and measured, not during module evaluation.
 *
 * ## The list is not a fallback
 *
 * Every node is also rendered as a real link in a real list, conditionally
 * hidden. That is not a degraded path for old browsers — it is the accessible
 * one, and it is what a keyboard user gets. The brief rules out `md:hidden` as
 * a way to restructure information, and this is the same principle applied
 * across the visual/a11y boundary rather than across a breakpoint: the canvas
 * carries the shape, the list carries the documents, and both are always in the
 * DOM.
 */

const GraphCanvas = dynamic(
  () => import('./graph-canvas').then((module) => module.GraphCanvas),
  {
    ssr: false,
    loading: () => (
      <p className="flex h-full items-center justify-center text-sm text-ink-subtle">
        Drawing…
      </p>
    ),
  },
)

const TYPE_FILTERS = [
  { value: 'post', label: 'Articles' },
  { value: 'note', label: 'Notes' },
  { value: 'project', label: 'Projects' },
  { value: 'tag', label: 'Tags' },
] as const satisfies readonly { value: GraphNodeKind; label: string }[]

type TypeFilter = (typeof TYPE_FILTERS)[number]['value']

/** Degrees offered by the filter. The top value is "any". */
const DEGREE_STEPS = [0, 2, 4, 8] as const

interface FetchState {
  status: 'loading' | 'ready' | 'error'
  graph: KnowledgeGraph | null
  message?: string
}

export function GraphExplorer() {
  const router = useRouter()

  const [state, setState] = useState<FetchState>({ status: 'loading', graph: null })
  const [types, setTypes] = useState<Set<TypeFilter>>(new Set())
  const [minDegree, setMinDegree] = useState<number>(0)

  useEffect(() => {
    // `AbortController` because React runs this effect twice in development,
    // and the first response would otherwise be applied after the second
    // request was already in flight.
    const controller = new AbortController()

    async function load() {
      try {
        const response = await fetch('/api/graph?limit=250', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })

        if (!response.ok) {
          setState({
            status: 'error',
            graph: null,
            message: `The graph could not be loaded (HTTP ${response.status}).`,
          })
          return
        }

        const graph = (await response.json()) as KnowledgeGraph
        setState({ status: 'ready', graph })
      } catch (error) {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          graph: null,
          message:
            error instanceof Error
              ? `The graph could not be loaded: ${error.message}`
              : 'The graph could not be loaded.',
        })
      }
    }

    void load()
    return () => controller.abort()
  }, [])

  const graph = state.graph

  /**
   * The visible subgraph.
   *
   * Edges are re-indexed against the filtered node list rather than filtered
   * alongside it. An edge that survives with its endpoints renumbered is the
   * only thing the canvas can use — an edge still pointing at an index from the
   * unfiltered array draws a line to whichever node happens to occupy that slot
   * now, which is worse than dropping it.
   */
  const visible = useMemo((): {
    nodes: GraphNode[]
    edges: { source: number; target: number }[]
    total: number
  } => {
    if (!graph) return { nodes: [], edges: [], total: 0 }

    const nodes: GraphNode[] = []
    const remapped = new Map<number, number>()

    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index]
      if (!node) continue
      if (types.size > 0 && !types.has(node.type)) continue
      if (node.degree < minDegree) continue

      remapped.set(index, nodes.length)
      nodes.push(node)
    }

    const edges: { source: number; target: number }[] = []
    for (const edge of graph.edges) {
      const source = remapped.get(edge.source)
      const target = remapped.get(edge.target)
      if (source === undefined || target === undefined) continue
      edges.push({ source, target })
    }

    return { nodes, edges, total: graph.total }
  }, [graph, minDegree, types])

  /** Nodes in the accessible list, best-connected first. */
  const listed = useMemo(
    () => [...visible.nodes].sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title)),
    [visible.nodes],
  )

  const toggleType = (value: TypeFilter) => {
    setTypes((current) => {
      const next = new Set(current)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const filtered = types.size > 0 || minDegree > 0

  /** How many of each kind are on screen. */
  const counts = useMemo(() => {
    let documents = 0
    let tags = 0
    for (const node of visible.nodes) {
      if (node.type === 'tag') tags += 1
      else documents += 1
    }
    return { documents, tags }
  }, [visible.nodes])

  /**
   * What the toolbar says about the view.
   *
   * The "of N" clauses are a disclosure of the server's caps, so they appear
   * only while nothing is filtered: a reader who has just narrowed the view by
   * hand knows why the number is small, and "3 of 1840 documents" would be
   * counting the selection against a corpus of a different kind. The figures
   * themselves are counted off the nodes in the payload rather than read from
   * the response's totals, which is what makes the tag cap visible — `tagTotal`
   * reports it, and a client that only ever printed what it received would show
   * the largest tags under a label implying they were all of them.
   */
  const summary = (() => {
    const parts = [
      `${counts.documents}${
        graph && !filtered && graph.total > counts.documents ? ` of ${graph.total}` : ''
      } ${counts.documents === 1 ? 'document' : 'documents'}`,
    ]

    // Shown when there are tags to count. Both cases that hide it are figures a
    // reader can do nothing with: a site whose documents carry no tags at all,
    // and a reader who has filtered to one kind of document and would be told
    // "0 tags" about a corpus whose tags are still on screen as a filter.
    if (counts.tags > 0) {
      parts.push(
        `${counts.tags}${
          graph && !filtered && graph.tagTotal > counts.tags ? ` of ${graph.tagTotal}` : ''
        } ${counts.tags === 1 ? 'tag' : 'tags'}`,
      )
    }

    return parts.join(' · ')
  })()

  return (
    <div className="flex flex-col">
      {/* -------------------------------------------------------------- */}
      {/*  Controls                                                       */}
      {/* -------------------------------------------------------------- */}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line pb-3 text-xs">
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">Filter by type</legend>
          {TYPE_FILTERS.map((filter) => (
            <label key={filter.value} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={types.has(filter.value)}
                onChange={() => toggleType(filter.value)}
                className="size-3.5 accent-[var(--color-brand)]"
              />
              <span className="text-ink-muted">{filter.label}</span>
            </label>
          ))}
        </fieldset>

        <div className="flex items-center gap-2">
          <label htmlFor="graph-degree" className="text-ink-subtle">
            Connections
          </label>
          <select
            id="graph-degree"
            value={minDegree}
            onChange={(event) => setMinDegree(Number(event.target.value))}
            className="border border-line bg-canvas px-1.5 py-1 text-xs text-ink-muted"
          >
            {DEGREE_STEPS.map((step) => (
              <option key={step} value={step}>
                {step === 0 ? 'any' : `${step}+`}
              </option>
            ))}
          </select>
        </div>

        <p className="ml-auto font-mono text-ink-subtle tabular-nums">
          {state.status === 'ready' ? summary : null}
        </p>

        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setTypes(new Set())
              setMinDegree(0)
            }}
            className="text-ink-muted transition-colors duration-150 hover:text-brand"
          >
            Reset
          </button>
        ) : null}
      </div>

      {/* -------------------------------------------------------------- */}
      {/*  States                                                         */}
      {/* -------------------------------------------------------------- */}

      {state.status === 'loading' ? (
        <div className="flex h-[26rem] items-center justify-center">
          <p className="text-sm text-ink-subtle">Loading the graph…</p>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="flex h-[26rem] flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-ink-muted">{state.message}</p>
          <p className="max-w-[46ch] text-xs text-ink-subtle">
            The graph is a view over the links between documents. The documents
            themselves are unaffected — browse the{' '}
            <Link href="/archive" className="transition-colors duration-150 hover:text-ink">
              archive
            </Link>{' '}
            instead.
          </p>
        </div>
      ) : null}

      {state.status === 'ready' && visible.nodes.length === 0 ? (
        <div className="flex h-[26rem] items-center justify-center px-6">
          <p className="text-sm text-ink-subtle">
            {graph && graph.nodes.length === 0
              ? 'No documents are linked to each other yet, so there is no graph to draw.'
              : 'No nodes match those filters.'}
          </p>
        </div>
      ) : null}

      {/* -------------------------------------------------------------- */}
      {/*  Graph and list                                                 */}
      {/* -------------------------------------------------------------- */}

      {state.status === 'ready' && visible.nodes.length > 0 ? (
        <>
          {/*
            The canvas is a fixed-height region rather than an aspect ratio. A
            force layout scales to whatever box it is given, and a box whose
            height depends on its width makes the layout — and therefore the
            picture — change shape when the reader resizes a window.
          */}
          <GraphCanvas
            className="mt-6 h-[26rem] w-full border border-line bg-surface sm:h-[34rem]"
            nodes={visible.nodes}
            edges={visible.edges}
            onOpen={(node) => router.push(node.url)}
          />

          <p className="mt-3 text-xs text-ink-subtle">
            Drag a node to move it. Click one to open the document.
          </p>

          {/* -------------------------------------------------------- */}
          {/*  The accessible graph                                       */}
          {/* -------------------------------------------------------- */}

          <section aria-labelledby="graph-index" className="mt-12">
            {/*
              The count, spelled out and pluralised, because this heading is the
              list's name for a screen reader and "All 1 nodes" is what the
              filters produce the moment a reader narrows to one node.
            */}
            <h2
              id="graph-index"
              className="border-b border-line pb-2 text-xs font-medium uppercase tracking-wider text-ink-subtle"
            >
              {listed.length} {listed.length === 1 ? 'node' : 'nodes'} in this view
            </h2>

            <ul className="mt-4 grid gap-x-10 gap-y-1 sm:grid-cols-2">
              {listed.map((node) => (
                <li key={node.id} className="flex items-baseline gap-3 py-1">
                  <Link
                    href={node.url}
                    className="min-w-0 flex-1 truncate text-sm text-ink-muted transition-colors duration-150 hover:text-brand"
                  >
                    {node.title}
                  </Link>
                  {/*
                    A tag is a link to a topic, and "Postgres Internals" at the
                    head of a list of documents reads as a document. The drawn
                    graph tells the two apart by shape; this is the same
                    information, in the medium the list has.
                  */}
                  {node.type === 'tag' ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-subtle/70">
                      Tag
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      'shrink-0 font-mono text-xs tabular-nums',
                      node.degree === 0 ? 'text-ink-subtle/70' : 'text-ink-subtle',
                    )}
                    title={`${node.degree} ${node.degree === 1 ? 'connection' : 'connections'}`}
                  >
                    {node.degree}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  )
}
