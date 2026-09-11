import { describe, expect, it } from 'vitest'
import { formatBytes } from '@/lib/utils/format'

/**
 * The four copies this replaced disagreed about both the arithmetic and the
 * unit names, so the assertions here are about what the number *means* rather
 * than about the string it happens to produce. A test that only pinned the
 * output would have passed against any one of the four.
 */

describe('formatBytes', () => {
  it('reads bytes as whole numbers and everything above them with one decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
  })

  it('scales by 1024 and says so', () => {
    // The point of the unit name: a reader who converts 1.5 MiB gets the byte
    // count the caller had. `MB` would send them to 1,500,000 instead.
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(1_572_864)).toBe('1.5 MiB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB')
  })

  it('carries on past the last unit rather than overflowing it', () => {
    // A library of a few terabytes is a real number for this column, and the
    // copy in `assets/process.ts` stopped at kilobytes and printed "5242880.0 KB".
    expect(formatBytes(1024 ** 4)).toBe('1.0 TiB')
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TiB')
  })

  it('is not confused by the boundary between two units', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KiB')
    expect(formatBytes(1024 * 1024 + 1)).toBe('1.0 MiB')
  })
})
