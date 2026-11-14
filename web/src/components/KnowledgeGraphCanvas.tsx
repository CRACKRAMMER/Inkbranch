import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import type { ContentType, GlobalGraph, GraphNode } from '../lib/types'

interface KnowledgeGraphCanvasProps {
  graph: GlobalGraph
  mode?: 'mini' | 'global'
  highlightNodeId?: string
  heightClass?: string
  onSelectNode?: (node: GraphNode) => void
}

interface SimNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
}

const NODE_COLORS: Record<ContentType, string> = {
  post: '#d97736',
  note: '#3b82f6',
  project: '#10b981',
}

export function KnowledgeGraphCanvas({
  graph,
  mode = 'global',
  highlightNodeId,
  heightClass = mode === 'mini' ? 'h-56' : 'h-[min(68dvh,38rem)]',
  onSelectNode,
}: KnowledgeGraphCanvasProps) {
  const navigate = useNavigate()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null)
  const [zoom, setZoom] = useState(1)
  const panRef = useRef({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const redrawRef = useRef<() => void>(() => {})
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number; moved: boolean }>({
    active: false,
    lastX: 0,
    lastY: 0,
    moved: false,
  })
  const simNodesRef = useRef<SimNode[]>([])
  const hoveredIdRef = useRef<string | null>(null)

  useEffect(() => {
    zoomRef.current = zoom
    redrawRef.current()
  }, [zoom])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !wrapper) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Initialize simulation nodes in golden-angle spiral for deterministic symmetry
    const nodes: SimNode[] = graph.nodes.map((n, i) => {
      const angle = i * 2.39996
      const radius = mode === 'mini' ? 28 + Math.sqrt(i) * 26 : 36 + Math.sqrt(i) * 42
      return {
        ...n,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      }
    })
    simNodesRef.current = nodes

    const nodeById = new Map<string, SimNode>()
    nodes.forEach((n) => nodeById.set(n.id, n))

    const edges = graph.edges
      .map((e) => ({
        ...e,
        src: nodeById.get(e.source),
        dst: nodeById.get(e.target),
      }))
      .filter((e): e is typeof e & { src: SimNode; dst: SimNode } => Boolean(e.src && e.dst))

    const runStep = (alpha: number) => {
      // Repulsion
      const repulsion = mode === 'mini' ? 1600 : 2800
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!
          const b = nodes[j]!
          let dx = b.x - a.x
          let dy = b.y - a.y
          let distSq = dx * dx + dy * dy
          if (distSq < 1) {
            dx = 0.7
            dy = 0.7
            distSq = 1
          }
          const force = (repulsion / distSq) * alpha
          const fx = dx * force
          const fy = dy * force
          a.vx -= fx
          a.vy -= fy
          b.vx += fx
          b.vy += fy
        }
      }

      // Edge spring attraction
      const targetLen = mode === 'mini' ? 70 : 108
      for (const edge of edges) {
        const dx = edge.dst.x - edge.src.x
        const dy = edge.dst.y - edge.src.y
        const dist = Math.hypot(dx, dy) || 1
        const strength = edge.kind === 'wikilink' ? 0.055 : edge.kind === 'series' ? 0.04 : 0.02
        const diff = (dist - targetLen) * strength * alpha
        const fx = (dx / dist) * diff
        const fy = (dy / dist) * diff
        edge.src.vx += fx
        edge.src.vy += fy
        edge.dst.vx -= fx
        edge.dst.vy -= fy
      }

      // Gentle gravity toward center + damping
      for (const n of nodes) {
        const pull = n.id === highlightNodeId ? 0.08 : 0.015
        n.vx = (n.vx - n.x * pull * alpha) * 0.84
        n.vy = (n.vy - n.y * pull * alpha) * 0.84
        n.x += n.vx
        n.y += n.vy
      }
    }

    // Pre-settle synchronously so canvas opens cleanly even with reduced motion
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const preSteps = reducedMotion ? 110 : 55
    for (let s = 0; s < preSteps; s++) {
      runStep(Math.max(0.18, 1 - s / preSteps))
    }

    let width = wrapper.clientWidth || 320
    let height = wrapper.clientHeight || 220

    const resize = () => {
      const rect = wrapper.getBoundingClientRect()
      width = Math.max(200, Math.floor(rect.width))
      height = Math.max(160, Math.floor(rect.height))
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(wrapper)

    const neighborIds = (centerId: string | null) => {
      const set = new Set<string>()
      if (!centerId) return set
      set.add(centerId)
      for (const e of edges) {
        if (e.source === centerId) set.add(e.target)
        if (e.target === centerId) set.add(e.source)
      }
      return set
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const styles = getComputedStyle(document.documentElement)
      const textColor = styles.getPropertyValue('--text-primary').trim() || '#333'
      const mutedColor = styles.getPropertyValue('--text-muted').trim() || '#888'
      const accentColor = styles.getPropertyValue('--accent').trim() || '#d97736'

      const focusId = hoveredIdRef.current || highlightNodeId || null
      const focusNeighbors = neighborIds(focusId)

      ctx.save()
      ctx.translate(width / 2 + panRef.current.x, height / 2 + panRef.current.y)
      ctx.scale(zoomRef.current, zoomRef.current)

      // Edges
      for (const e of edges) {
        const isHighlightedEdge =
          focusId && (e.source === focusId || e.target === focusId)
        ctx.beginPath()
        ctx.moveTo(e.src.x, e.src.y)
        ctx.lineTo(e.dst.x, e.dst.y)
        if (isHighlightedEdge) {
          ctx.strokeStyle = accentColor
          ctx.lineWidth = e.kind === 'wikilink' ? 2 : 1.4
          ctx.globalAlpha = 0.85
        } else {
          ctx.strokeStyle = mutedColor
          ctx.lineWidth = e.kind === 'wikilink' ? 1.2 : 0.8
          ctx.globalAlpha = focusId ? 0.14 : e.kind === 'shared-tag' ? 0.24 : 0.42
        }
        if (e.kind === 'shared-tag') {
          ctx.setLineDash([4, 4])
        } else {
          ctx.setLineDash([])
        }
        ctx.stroke()
      }
      ctx.setLineDash([])

      // Nodes
      for (const n of nodes) {
        const isCurrent = n.id === highlightNodeId
        const isHovered = n.id === hoveredIdRef.current
        const isDimmed = Boolean(focusId && !focusNeighbors.has(n.id))
        const radius =
          (mode === 'mini' ? 4.5 : 5) +
          Math.min(6, Math.sqrt(Math.max(1, n.degree)) * 1.4) +
          (isCurrent ? 2.5 : 0)

        ctx.globalAlpha = isDimmed ? 0.25 : 1
        ctx.beginPath()
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2)
        ctx.fillStyle = isCurrent ? accentColor : NODE_COLORS[n.type] ?? accentColor
        ctx.fill()

        if (isHovered || isCurrent) {
          ctx.lineWidth = 2.2
          ctx.strokeStyle = textColor
          ctx.stroke()
        }

        const showLabel =
          mode === 'global' || isHovered || isCurrent || (focusId && focusNeighbors.has(n.id))
        if (showLabel) {
          ctx.font = `${isCurrent || isHovered ? '600 ' : ''}11px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillStyle = textColor
          const shortTitle = n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title
          ctx.fillText(shortTitle, n.x, n.y + radius + 4)
        }
      }

      ctx.restore()
    }

    let rafId = 0
    let isVisible = true
    let ticksLeft = reducedMotion ? 0 : 90

    const loop = () => {
      if (!isVisible || document.visibilityState === 'hidden') return
      if (ticksLeft > 0) {
        runStep(Math.max(0.06, ticksLeft / 120))
        ticksLeft--
      }
      draw()
      if (ticksLeft > 0 || dragRef.current.active || hoveredIdRef.current) {
        rafId = window.requestAnimationFrame(loop)
      }
    }

    const io = new IntersectionObserver((entries) => {
      isVisible = Boolean(entries[0]?.isIntersecting)
      if (isVisible) {
        draw()
        if (ticksLeft > 0 && !rafId) {
          rafId = window.requestAnimationFrame(loop)
        }
      } else if (rafId) {
        window.cancelAnimationFrame(rafId)
        rafId = 0
      }
    })
    io.observe(wrapper)

    draw()
    redrawRef.current = draw
    if (ticksLeft > 0) {
      rafId = window.requestAnimationFrame(loop)
    }

    const hitTest = (clientX: number, clientY: number): SimNode | null => {
      const rect = canvas.getBoundingClientRect()
      const sx = (clientX - rect.left - width / 2 - panRef.current.x) / zoomRef.current
      const sy = (clientY - rect.top - height / 2 - panRef.current.y) / zoomRef.current
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!
        const dist = Math.hypot(sx - n.x, sy - n.y)
        if (dist <= 12 / zoomRef.current) {
          return n
        }
      }
      return null
    }

    const onPointerDown = (e: PointerEvent) => {
      dragRef.current = {
        active: true,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (dragRef.current.active) {
        const dx = e.clientX - dragRef.current.lastX
        const dy = e.clientY - dragRef.current.lastY
        if (Math.hypot(dx, dy) > 3) {
          dragRef.current.moved = true
        }
        panRef.current.x += dx
        panRef.current.y += dy
        dragRef.current.lastX = e.clientX
        dragRef.current.lastY = e.clientY
        draw()
        return
      }
      const hit = hitTest(e.clientX, e.clientY)
      const nextId = hit?.id ?? null
      if (nextId !== hoveredIdRef.current) {
        hoveredIdRef.current = nextId
        setHoveredNode(hit)
        canvas.style.cursor = hit ? 'pointer' : 'grab'
        draw()
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const wasClick = dragRef.current.active && !dragRef.current.moved
      dragRef.current.active = false
      if (wasClick) {
        const hit = hitTest(e.clientX, e.clientY)
        if (hit) {
          if (onSelectNode) {
            onSelectNode(hit)
          } else {
            void navigate({ to: hit.url })
          }
        }
      }
    }

    const onPointerLeave = () => {
      dragRef.current.active = false
      if (hoveredIdRef.current) {
        hoveredIdRef.current = null
        setHoveredNode(null)
        draw()
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)

    return () => {
      ro.disconnect()
      io.disconnect()
      if (rafId) window.cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [graph, mode, highlightNodeId, navigate, onSelectNode])

  const resetView = () => {
    panRef.current = { x: 0, y: 0 }
    setZoom(1)
  }

  return (
    <div
      ref={wrapperRef}
      className={`relative w-full overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] ${heightClass}`}
    >
      <canvas
        ref={canvasRef}
        aria-label={mode === 'mini' ? '本文局部知识关系图谱' : '全站知识关系图谱画布'}
        className="block h-full w-full touch-none"
      />

      {/* Graph controls & tooltip badge */}
      {mode === 'global' ? (
        <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/90 p-1 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.45, +(z - 0.2).toFixed(2)))}
            aria-label="缩小图谱"
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.2).toFixed(2)))}
            aria-label="放大图谱"
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={resetView}
            aria-label="重置视图"
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {hoveredNode ? (
        <div className="pointer-events-none absolute top-3 left-3 max-w-60 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 px-2.5 py-1.5 text-xs shadow-[var(--shadow-card)] backdrop-blur-sm">
          <div className="truncate font-semibold text-[var(--text-primary)]">
            {hoveredNode.title}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">
            关联度 {hoveredNode.degree} · 点击跳转
          </div>
        </div>
      ) : null}
    </div>
  )
}
