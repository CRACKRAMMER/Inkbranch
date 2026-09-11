import { describe, expect, it } from 'vitest'

import { layoutGraph, type LayoutEdge, type LayoutNode } from '@/lib/graph/layout'

/**
 * The layout engine.
 *
 * These test properties, not coordinates. A force-directed layout has no
 * canonical answer — any assertion against exact positions would be asserting
 * that the implementation has not changed, which is the opposite of useful.
 * What must hold is that it is deterministic, that it stays in frame, that
 * connected nodes end up nearer than unconnected ones, and that it terminates.
 */

const WIDTH = 800
const HEIGHT = 600

/** A chain a—b—c—d, plus two nodes joined only to `a`. */
function chainGraph() {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, degree: 1 }))
  const edges: LayoutEdge[] = [
    { source: 0, target: 1 },
    { source: 1, target: 2 },
    { source: 2, target: 3 },
    { source: 0, target: 4 },
    { source: 0, target: 5 },
  ]
  return { nodes, edges }
}

/** A ring of `size` nodes, each joined to the next and the last back to the first. */
function ringGraph(size: number) {
  const nodes = Array.from({ length: size }, (_, i) => ({ id: `n${i}`, degree: 2 }))
  const edges: LayoutEdge[] = nodes.map((_, i) => ({
    source: i,
    target: (i + 1) % size,
  }))
  return { nodes, edges }
}

const distance = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): number => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * The laid-out node for an id.
 *
 * `noUncheckedIndexedAccess` types every lookup and every destructured element
 * as possibly absent, which is correct of a general array and noise in a test
 * that just asserted the length. This narrows once, at the point of use, and
 * fails the test rather than the type checker if the node is genuinely missing.
 */
function at(nodes: LayoutNode[], id: string): LayoutNode {
  const found = nodes.find((node) => node.id === id)
  if (!found) throw new Error(`no node ${id} in the layout`)
  return found
}

describe('layoutGraph', () => {
  it('returns nothing for an empty graph', () => {
    expect(layoutGraph([], [], { width: WIDTH, height: HEIGHT })).toEqual([])
  })

  it('places a lone node in the middle', () => {
    const result = layoutGraph([{ id: 'only', degree: 0 }], [], {
      width: WIDTH,
      height: HEIGHT,
    })

    expect(result).toEqual([{ id: 'only', x: WIDTH / 2, y: HEIGHT / 2, degree: 0 }])
  })

  it('is deterministic across calls', () => {
    const { nodes, edges } = chainGraph()

    const first = layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })
    const second = layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })

    // This is the property that makes the page usable: a reader who comes back
    // to a picture they learned last week finds the same picture.
    expect(second).toEqual(first)
  })

  it('does not depend on Math.random', () => {
    const { nodes, edges } = chainGraph()
    const original = Math.random
    Math.random = () => {
      throw new Error('layoutGraph must not use Math.random')
    }

    try {
      expect(() => layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })).not.toThrow()
    } finally {
      Math.random = original
    }
  })

  it('returns one finite position per node', () => {
    const { nodes, edges } = ringGraph(40)

    const result = layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })

    expect(result).toHaveLength(nodes.length)
    for (const node of result) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }
  })

  it('pulls connected nodes closer together than unconnected ones', () => {
    const { nodes, edges } = chainGraph()

    const result = layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })

    // `a` is joined to `b`, `e` and `f`; `d` is joined only to `c`. The mean
    // distance from `a` to its neighbours must beat the mean distance from `a`
    // to the nodes it has no edge to.
    const a = at(result, 'a')
    const neighbours =
      (distance(a, at(result, 'b')) +
        distance(a, at(result, 'e')) +
        distance(a, at(result, 'f'))) /
      3
    const strangers = (distance(a, at(result, 'c')) + distance(a, at(result, 'd'))) / 2

    expect(neighbours).toBeLessThan(strangers)
  })

  it('keeps a connected graph inside its frame', () => {
    const { nodes, edges } = ringGraph(30)

    const result = layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })

    // Not a hard guarantee of the algorithm — a disconnected component is
    // pushed outward deliberately — but a connected graph that escapes the
    // canvas is a layout that has diverged, and this is what catches it.
    for (const node of result) {
      expect(node.x).toBeGreaterThan(-WIDTH)
      expect(node.x).toBeLessThan(WIDTH * 2)
      expect(node.y).toBeGreaterThan(-HEIGHT)
      expect(node.y).toBeLessThan(HEIGHT * 2)
    }
  })

  it('settles: more iterations stop moving the nodes much', () => {
    const { nodes, edges } = ringGraph(20)

    const short = layoutGraph(nodes, edges, {
      width: WIDTH,
      height: HEIGHT,
      iterations: 150,
    })
    const long = layoutGraph(nodes, edges, {
      width: WIDTH,
      height: HEIGHT,
      iterations: 600,
    })

    // The step size is capped by a temperature that cools to zero, so the
    // difference between a 150-step and a 600-step layout is bounded by the
    // remaining temperature rather than by the size of the canvas. Without
    // cooling the two would differ by as much as the graph is wide.
    const drift = short.map((node, index) => {
      const counterpart = long[index]
      if (!counterpart) throw new Error(`layout length changed at ${index}`)
      return distance(node, counterpart)
    })
    const worst = Math.max(...drift)

    expect(worst).toBeLessThan(WIDTH * 0.6)
  })

  it('honours a pinned node', () => {
    const { nodes, edges } = chainGraph()

    const result = layoutGraph(nodes, edges, {
      width: WIDTH,
      height: HEIGHT,
      pinned: { index: 2, x: 10, y: 20 },
    })

    expect(result[2]).toMatchObject({ id: 'c', x: 10, y: 20 })
  })

  it('accepts initial positions instead of seeding', () => {
    const { nodes, edges } = chainGraph()
    const initial = nodes.map((_, i) => ({ x: 100 + i * 5, y: 200 + i * 3 }))

    // Zero iterations, so the result is the seed with no forces applied at all.
    const result = layoutGraph(nodes, edges, {
      width: WIDTH,
      height: HEIGHT,
      iterations: 0,
      initial,
    })

    expect(result.map((node) => ({ x: node.x, y: node.y }))).toEqual(initial)
  })

  it('carries degree through to the result', () => {
    const nodes = [
      { id: 'hub', degree: 12 },
      { id: 'leaf', degree: 1 },
    ]

    const result = layoutGraph(nodes, [], { width: WIDTH, height: HEIGHT })

    expect(result.map((node) => node.degree)).toEqual([12, 1])
  })

  it('lays out 250 nodes within a reasonable time', () => {
    // The page's default ceiling. This is a guard against an accidental change
    // that turns a quadratic pass into something worse, not a benchmark.
    const { nodes, edges } = ringGraph(250)

    const started = performance.now()
    const result = layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT })
    const took = performance.now() - started

    expect(result).toHaveLength(250)
    expect(took).toBeLessThan(2000)
  })
})
