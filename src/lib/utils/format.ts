/**
 * Byte counts as a person reads them.
 *
 * There were four copies of this before, and they disagreed. A five-megabyte
 * file came out as "5.0 MiB" on the import screen, "5120.0 KB" on an upload
 * error, and "5.0 MB" on the revision pages — and neither of the two that said
 * "MB" was doing decimal arithmetic, so the label was simply wrong about what
 * the number meant.
 *
 * These are binary multiples of 1024, so the units are the binary ones. `KiB`
 * looks pedantic next to `KB`, and it is the only spelling that is not a claim
 * the arithmetic does not support: a reader who converts 1.5 MiB to bytes and
 * gets 1,572,864 arrived at the number on the screen, and a reader who does the
 * same with 1.5 MB gets 1,500,000 and concludes the display is wrong.
 *
 * One decimal place, throughout: enough to tell 1.4 from 1.5, which is what a
 * size is read for. Nothing here needs to be exact to the byte — every caller
 * is either a message to a person or a figure on a status line.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  // Bytes are whole; everything above them is not. `0 B` rather than `0.0 B`,
  // and no unit that a reader has to look up to read a file size.
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`
}
