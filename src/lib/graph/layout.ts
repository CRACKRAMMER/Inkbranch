/**
 * Force-directed layout for the knowledge graph.
 *
 * Fruchterman–Reingold, and the classic formulation rather than a tuned
 * variant, because the constants below are the ones with fifty years of
 * literature behind them and every deviation from them makes the result harder
 * to reason about rather than better. Two forces: every pair of nodes pushes
 * apart with `k²/d`, every edge pulls its endpoints together with `d²/k`, and a
 * cooling schedule caps how far a node may move per iteration so the system
 * settles instead of oscillating.
 *
 * ## Why this is not animated
 *
 * The layout is computed to convergence in one synchronous pass and drawn once.
 * A live simulation is the obvious thing to reach for and it is the wrong
 * trade here: it holds a `requestAnimationFrame` loop open for the lifetime of
 * the page, on a page whose content is a picture that does not change. The
 * reader gets the settled layout immediately instead of watching it wobble,
 * and the site gets a graph page that costs nothing while it sits open. The
 * only interaction that re-runs it is dragging a node, which is a deliberate
 * act with a visible result.
 *
 * ## Why it is deterministic
 *
 * Initial positions come from a hash of the node id, not from `Math.random`.
 * A layout that reshuffles on every visit is disorienting — a reader who
 * returns to the page cannot recognise the shape they learned last time, which
 * is most of what a picture of a graph is for.
 *
 * ## Cost
 *
 * Repulsion is all-pairs and therefore O(n²). At the default 150 nodes and 300
 * iterations that is 6.75 million pair evaluations, each of which exits on a
 * squared-distance comparison before it does any division — tens of
 * milliseconds, once, on the client. The cutoff is what keeps it there: pairs
 * beyond `CUTOFF_FACTOR` × k are skipped entirely, and in a settled FR layout
 * almost every pair is beyond it. Raising the node limit is the one change that
 * would make this quadratic in earnest, which is why the page caps it.
 */

/** One laid-out node. Positions are in the layout's own coordinate space. */
export interface LayoutNode {
  id: string
  x: number
  y: number
  /** Distinct neighbours, in either direction. Drives the drawn radius. */
  degree: number
}

/** An edge, as indices into the node array it was built from. */
export interface LayoutEdge {
  source: number
  target: number
}

export interface LayoutOptions {
  width: number
  height: number
  /**
   * Cooling steps. Each is one pass of forces. Fewer converges faster and
   * leaves the graph looser; more packs the clusters tighter and costs
   * linearly.
   */
  iterations?: number
  /** Pins a node at a position for one call, used while dragging. */
  pinned?: { index: number; x: number; y: number } | undefined
  /** Positions to start from instead of the deterministic seed. */
  initial?: readonly { x: number; y: number }[] | undefined
}

export const DEFAULT_ITERATIONS = 300

/**
 * How far apart, in multiples of the ideal edge length `k`, two nodes can be
 * before their repulsion is ignored.
 *
 * Three is far enough that the force is under a tenth of its peak and the
 * missing contribution is invisible in the result, and close enough that a
 * settled graph skips the large majority of its pairs.
 */
const CUTOFF_FACTOR = 3

/** Fraction of the ideal length a node may move in the first iteration. */
const INITIAL_TEMPERATURE = 0.1

/**
 * Lay out a graph.
 *
 * `nodes` are identified by id and carry their degree, which is used only to
 * decide how large the drawn dot is — the physics treats every node alike, so a
 * hub does not get to shove its neighbours harder than a leaf does.
 */
export function layoutGraph(
  nodes: readonly { id: string; degree: number }[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions,
): LayoutNode[] {
  const { width, height, iterations = DEFAULT_ITERATIONS } = options
  const count = nodes.length

  if (count === 0) return []
  if (count === 1) {
    const only = nodes[0]
    if (!only) return []
    return [{ id: only.id, x: width / 2, y: height / 2, degree: only.degree }]
  }

  // The ideal edge length. `sqrt(area / n)` is the FR definition: the spacing
  // at which every node has, on average, one node's worth of room.
  const k = Math.sqrt((width * height) / count)
  const cutoff = k * CUTOFF_FACTOR
  const cutoffSquared = cutoff * cutoff

  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  const dxs = new Float64Array(count)
  const dys = new Float64Array(count)

  seedPositions(nodes, xs, ys, width, height, options.initial)

  let temperature = k * INITIAL_TEMPERATURE
  const cooling = temperature / (iterations + 1)

  // `layoutGraph` is called again on every frame of a drag, so the temporaries
  // above are allocated once per call rather than per iteration. Typed arrays
  // rather than plain arrays because the inner loop indexes them six times per
  // pair and the bounds checks are not free at this count.
  for (let step = 0; step < iterations; step += 1) {
    dxs.fill(0)
    dys.fill(0)

    applyRepulsion(xs, ys, dxs, dys, count, k, cutoffSquared)
    applyAttraction(xs, ys, dxs, dys, edges, k)
    applyGravity(xs, ys, dxs, dys, count, width, height)

    if (options.pinned) {
      // A pinned node takes no force at all, rather than being moved back
      // afterwards. Moving it back would leave its displacement in the array
      // for the neighbours it pushed during the same step to react to, and the
      // dragged node would feel like it had weight it does not have.
      const { index } = options.pinned
      dxs[index] = 0
      dys[index] = 0
    }

    for (let i = 0; i < count; i += 1) {
      // The `?? 0` reads below — and the ones in the three force passes — are
      // what `noUncheckedIndexedAccess` requires of an indexed read. Every one
      // of them is out of range only if `count` has drifted from the arrays'
      // length, which would be a bug worth crashing on rather than papering
      // over; the fallback keeps the loop readable instead of scattering
      // non-null assertions through the hot path.
      const dx = dxs[i] ?? 0
      const dy = dys[i] ?? 0
      const magnitude = Math.sqrt(dx * dx + dy * dy)
      if (magnitude === 0) continue

      // Clamping the *step*, not the force. FR's cooling schedule is a limit on
      // displacement, and applying it to the force instead lets a node with one
      // very distant neighbour teleport across the canvas on the first pass.
      const step = Math.min(magnitude, temperature) / magnitude
      xs[i] = (xs[i] ?? 0) + dx * step
      ys[i] = (ys[i] ?? 0) + dy * step
    }

    temperature -= cooling
  }

  if (options.pinned) {
    xs[options.pinned.index] = options.pinned.x
    ys[options.pinned.index] = options.pinned.y
  }

  return nodes.map((node, index) => ({
    id: node.id,
    x: xs[index] ?? width / 2,
    y: ys[index] ?? height / 2,
    degree: node.degree,
  }))
}

/**
 * Deterministic starting positions, on a phyllotaxis spiral.
 *
 * Not random. Random points clump, and a clump is a cluster of near-coincident
 * nodes whose repulsion is enormous and nearly cancelling — the layout spends
 * its first hundred iterations just untangling them. The golden-angle spiral
 * covers the disc evenly, so the first iteration starts from an already
 * reasonable spread, and it is a pure function of the index, so it is the same
 * every time.
 *
 * Node ids only perturb it slightly, which keeps two documents that happen to
 * sit next to each other from being perfectly symmetric.
 */
function seedPositions(
  nodes: readonly { id: string }[],
  xs: Float64Array,
  ys: Float64Array,
  width: number,
  height: number,
  initial: readonly { x: number; y: number }[] | undefined,
): void {
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.42
  const golden = Math.PI * (3 - Math.sqrt(5))

  for (let i = 0; i < nodes.length; i += 1) {
    const given = initial?.[i]
    if (given) {
      xs[i] = given.x
      ys[i] = given.y
      continue
    }

    // `sqrt` of the normalised index, so the points are spread over the *area*
    // of the disc rather than bunching at the centre the way a linear radius
    // would put them.
    const spread = Math.sqrt((i + 0.5) / nodes.length)
    const angle = i * golden

    // A few percent of jitter, derived from the id, to break the symmetry that
    // would otherwise put every node on an exact spiral arm.
    const jitter = (idNoise(nodes[i]?.id ?? '') - 0.5) * 0.04 * radius

    xs[i] = centerX + Math.cos(angle) * (spread * radius + jitter)
    ys[i] = centerY + Math.sin(angle) * (spread * radius + jitter)
  }
}

/**
 * A stable number in [0, 1) from a node id.
 *
 * FNV-1a, and local to this file because the layout is its only consumer.
 * Sharing it would mean naming a general-purpose string hash after the one
 * thing that happens to use it, and the next caller would reasonably expect it
 * to be a good hash rather than a cheap one. `Math.imul` keeps the multiply in
 * 32-bit range; a plain `*` would go through a double and lose the low bits
 * that carry the entropy.
 */
function idNoise(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 4294967296
}

/** All-pairs repulsion, with an early exit past the cutoff. */
function applyRepulsion(
  xs: Float64Array,
  ys: Float64Array,
  dxs: Float64Array,
  dys: Float64Array,
  count: number,
  k: number,
  cutoffSquared: number,
): void {
  const kSquared = k * k

  for (let i = 0; i < count; i += 1) {
    const xi = xs[i] ?? 0
    const yi = ys[i] ?? 0
    // `i`'s own contribution is accumulated in locals and written once, which
    // is one bounds-checked read and one write per outer step instead of two
    // of each per pair.
    let forceX = 0
    let forceY = 0

    // `j` starts at `i + 1` because the force is symmetric: computing each pair
    // once and applying it to both endpoints halves the work exactly.
    for (let j = i + 1; j < count; j += 1) {
      const dx = xi - (xs[j] ?? 0)
      const dy = yi - (ys[j] ?? 0)
      const distanceSquared = dx * dx + dy * dy

      if (distanceSquared > cutoffSquared) continue

      // Two nodes at the same point have no direction to separate along. The
      // `i`/`j` indices break the tie, so a coincidence pushes them apart along
      // a fixed axis instead of dividing by zero.
      const distance = Math.sqrt(distanceSquared)
      const force = kSquared / (distance > 0.01 ? distance : 0.01)
      const ux = distance > 0.01 ? dx / distance : i % 2 === 0 ? 1 : -1
      const uy = distance > 0.01 ? dy / distance : 0

      forceX += ux * force
      forceY += uy * force
      // `j` may already carry contributions from earlier outer steps, so this
      // adds rather than assigns.
      dxs[j] = (dxs[j] ?? 0) - ux * force
      dys[j] = (dys[j] ?? 0) - uy * force
    }

    dxs[i] = (dxs[i] ?? 0) + forceX
    dys[i] = (dys[i] ?? 0) + forceY
  }
}

/** Spring attraction along each edge. */
function applyAttraction(
  xs: Float64Array,
  ys: Float64Array,
  dxs: Float64Array,
  dys: Float64Array,
  edges: readonly LayoutEdge[],
  k: number,
): void {
  for (const edge of edges) {
    const { source, target } = edge
    const dx = (xs[source] ?? 0) - (xs[target] ?? 0)
    const dy = (ys[source] ?? 0) - (ys[target] ?? 0)
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance < 0.01) continue

    // `d²/k` is FR's attractive force. It grows with distance, which is what
    // makes it eventually dominate the `k²/d` repulsion and hold an edge at a
    // stable length instead of letting the pair drift apart forever.
    const force = (distance * distance) / k
    const ux = dx / distance
    const uy = dy / distance

    dxs[source] = (dxs[source] ?? 0) - ux * force
    dys[source] = (dys[source] ?? 0) - uy * force
    dxs[target] = (dxs[target] ?? 0) + ux * force
    dys[target] = (dys[target] ?? 0) + uy * force
  }
}

/**
 * A weak pull toward the centre, proportional to distance.
 *
 * FR has no gravity and does not need it for a connected graph. This one is
 * here for the disconnected one: a component with no edges to the rest has
 * nothing holding it in frame, and repulsion alone will push it off the canvas
 * entirely, where it is invisible. The constant is small enough that it does
 * not visibly compress a connected layout.
 */
function applyGravity(
  xs: Float64Array,
  ys: Float64Array,
  dxs: Float64Array,
  dys: Float64Array,
  count: number,
  width: number,
  height: number,
): void {
  const centerX = width / 2
  const centerY = height / 2
  const strength = 0.01

  for (let i = 0; i < count; i += 1) {
    dxs[i] = (dxs[i] ?? 0) + (centerX - (xs[i] ?? 0)) * strength
    dys[i] = (dys[i] ?? 0) + (centerY - (ys[i] ?? 0)) * strength
  }
}
