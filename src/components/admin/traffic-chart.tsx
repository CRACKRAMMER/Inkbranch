'use client'

import { useId, useState } from 'react'

import { cn } from '@/lib/utils/cn'

/**
 * Daily views and visitors, as two lines on one axis.
 *
 * Both series are counts of the same kind of thing, so they share one scale —
 * a second axis would let the two lines be drawn any way the author liked
 * relative to each other, which is the one thing a chart must not do. Two
 * series means a legend, and the palette is the validated pair from
 * `admin.css`; the peak is labelled directly so the busiest day is readable
 * without hovering.
 *
 * The table underneath is not a fallback for a broken chart: it is the same
 * data in the form a screen reader, a spreadsheet and a printout can use, and
 * it is the reason the chart itself is one labelled image rather than a tree of
 * focusable marks. Hover is the only pointer interaction — a line chart has no
 * hit target to press, and a tooltip that can only be reached with a mouse is
 * worth exactly what the table beside it already provides for a keyboard.
 */

export interface TrafficPoint {
  day: string
  views: number
  visitors: number
}

const WIDTH = 720
const HEIGHT = 180
const PAD_X = 8
const PAD_TOP = 12
const PAD_BOTTOM = 22

export function TrafficChart({ series }: { series: TrafficPoint[] }) {
  const [active, setActive] = useState<number | null>(null)
  const titleId = useId()

  const totals = series.reduce(
    (sum, point) => ({ views: sum.views + point.views, visitors: sum.visitors + point.visitors }),
    { views: 0, visitors: 0 },
  )

  if (series.length === 0) {
    return <p className="border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
      The range contains no days.
    </p>
  }

  const peak = series.reduce((max, point) => Math.max(max, point.views), 0)
  const scaleMax = niceCeiling(Math.max(peak, 1))
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM
  const step = series.length > 1 ? (WIDTH - PAD_X * 2) / (series.length - 1) : 0

  const x = (index: number) =>
    series.length > 1 ? PAD_X + index * step : WIDTH / 2
  const y = (value: number) => PAD_TOP + plotHeight - (value / scaleMax) * plotHeight

  const line = (key: 'views' | 'visitors') =>
    series.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)} ${y(point[key])}`).join(' ')

  const peakIndex = series.findIndex((point) => point.views === peak)
  const activePoint = active === null ? null : series[active]
  const activeX = active === null ? 0 : x(active)

  const first = series[0]
  const last = series[series.length - 1]
  const gridlines = [0, 0.5, 1].map((fraction) => ({
    value: Math.round(scaleMax * fraction),
    y: y(scaleMax * fraction),
  }))

  return (
    <figure className="border border-line">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-sunken px-3 py-2">
        <span className="text-xs text-ink-muted" id={titleId}>
          Views and visitors per day
        </span>
        <span className="flex flex-wrap items-center gap-4 text-xs">
          <LegendItem className="bg-chart-views" label="Views" value={totals.views} />
          <LegendItem className="bg-chart-visitors" label="Visitors" value={totals.visitors} />
        </span>
      </figcaption>

      <div className="relative px-3 py-3">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full"
          role="img"
          aria-labelledby={titleId}
          onMouseLeave={() => setActive(null)}
        >
          {gridlines.map((line) => (
            <g key={line.value}>
              <line
                x1={0}
                x2={WIDTH}
                y1={line.y}
                y2={line.y}
                className="stroke-line"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={line.value === 0 ? undefined : '3 3'}
              />
              <text
                x={0}
                y={line.y - 4}
                className="fill-ink-subtle font-mono"
                fontSize={10}
              >
                {line.value}
              </text>
            </g>
          ))}

          <path
            d={line('visitors')}
            fill="none"
            className="stroke-chart-visitors"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={line('views')}
            fill="none"
            className="stroke-chart-views"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {peak > 0 ? (
            <>
              <circle cx={x(peakIndex)} cy={y(peak)} r={3} className="fill-chart-views" />
              <text
                x={Math.min(Math.max(x(peakIndex), 20), WIDTH - 20)}
                y={Math.max(y(peak) - 8, 10)}
                textAnchor="middle"
                fontSize={10}
                className="fill-ink-muted font-mono"
              >
                {peak}
              </text>
            </>
          ) : null}

          {activePoint ? (
            <line
              x1={activeX}
              x2={activeX}
              y1={PAD_TOP}
              y2={PAD_TOP + plotHeight}
              className="stroke-line-strong"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {series.map((point, index) => (
            <rect
              key={point.day}
              x={x(index) - step / 2}
              y={0}
              width={Math.max(step, 8)}
              height={HEIGHT}
              fill="transparent"
              onMouseEnter={() => setActive(index)}
            />
          ))}

          <text x={PAD_X} y={HEIGHT - 6} fontSize={10} className="fill-ink-subtle font-mono">
            {first?.day}
          </text>
          <text
            x={WIDTH - PAD_X}
            y={HEIGHT - 6}
            fontSize={10}
            textAnchor="end"
            className="fill-ink-subtle font-mono"
          >
            {last?.day}
          </text>
        </svg>

        {activePoint ? (
          <div
            className="pointer-events-none absolute top-3 z-10 min-w-[9rem] -translate-x-1/2 border border-line bg-surface px-2 py-1.5 text-xs shadow-none"
            style={{ left: `${(activeX / WIDTH) * 100}%` }}
          >
            <p className="font-mono text-ink">{activePoint.day}</p>
            <p className="mt-1 flex items-center gap-2 text-ink-muted">
              <span aria-hidden="true" className="inline-block size-2 bg-chart-views" />
              {activePoint.views} view{activePoint.views === 1 ? '' : 's'}
            </p>
            <p className="flex items-center gap-2 text-ink-muted">
              <span aria-hidden="true" className="inline-block size-2 bg-chart-visitors" />
              {activePoint.visitors} visitor{activePoint.visitors === 1 ? '' : 's'}
            </p>
          </div>
        ) : null}
      </div>

      <details className="border-t border-line">
        <summary className="cursor-pointer px-3 py-2 text-xs text-ink-muted">
          Table view — every day in the range
        </summary>
        <div className="max-h-72 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">Views and visitors for each day in the range</caption>
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-1.5 font-medium text-ink-muted">
                  Day
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium text-ink-muted">
                  Views
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium text-ink-muted">
                  Visitors
                </th>
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr key={point.day} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-1 text-left font-mono font-normal text-ink">
                    {point.day}
                  </th>
                  <td className="px-3 py-1 text-right tabular-nums text-ink">{point.views}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-ink-muted">
                    {point.visitors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

function LegendItem({
  className,
  label,
  value,
}: {
  className: string
  label: string
  value: number
}) {
  return (
    <span className="inline-flex items-center gap-2 text-ink-muted">
      <span aria-hidden="true" className={cn('inline-block size-2', className)} />
      {label}
      <span className="tabular-nums text-ink">{value}</span>
    </span>
  )
}

/**
 * Round the axis top up to something a reader can divide.
 *
 * An axis that ends at 137 produces gridlines nobody can do arithmetic with;
 * the cost of the extra headroom is a line that sits slightly lower.
 */
function niceCeiling(value: number): number {
  if (value <= 4) return 4
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    const candidate = step * magnitude
    if (candidate >= value) return candidate
  }
  return 10 * magnitude
}
