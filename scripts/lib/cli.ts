import process from 'node:process'

/**
 * Small helpers shared by the scripts under `scripts/`.
 *
 * Deliberately not a framework. The scripts are read far more often than they
 * are run, and a bespoke argument parser would be one more thing to learn
 * before reading `sync.ts`. What is here is the arithmetic that has to be
 * identical across every command — exit codes, and the shape of the summary
 * block — so the output looks the same whichever script you run.
 */

/** Flags are `--name` or `--name=value`; everything else is a positional. */
export interface Args {
  positional: string[]
  flags: Record<string, string | true>
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }

    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq === -1) {
      flags[body] = true
    } else {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
    }
  }

  return { positional, flags }
}

export function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags[name] !== undefined
}

/**
 * A positive integer flag, or the fallback.
 *
 * `Number.parseInt('12abc')` is 12, so a typo silently becomes a different
 * limit rather than an error. Checking the round-trip is what makes the flag
 * trustworthy: either it parses cleanly or the fallback is used and the caller
 * can say so.
 */
export function flagInt(
  args: Args,
  name: string,
  fallback: number,
): number {
  const raw = flagString(args, name)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === raw.trim()
    ? parsed
    : fallback
}

const USE_COLOR =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined

const wrap = (code: string) => (text: string) =>
  USE_COLOR ? `[${code}m${text}[0m` : text

export const style = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
}

/** Section header. Printed before each phase so long runs show progress. */
export function heading(text: string): void {
  console.log(`\n${style.bold(text)}`)
}

/** `- key: value` lines, aligned on the colon. */
export function report(pairs: Record<string, string | number | boolean>): void {
  const entries = Object.entries(pairs)
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0)

  for (const [key, value] of entries) {
    console.log(`  ${key.padEnd(width)}  ${String(value)}`)
  }
}

export function info(message: string): void {
  console.log(`  ${message}`)
}

export function warn(message: string): void {
  console.error(`${style.yellow('warning')} ${message}`)
}

export function fail(message: string): void {
  console.error(`${style.red('error')} ${message}`)
}

/**
 * Run a command, printing the failure and setting a non-zero exit code.
 *
 * `process.exitCode` rather than `process.exit()`: exiting immediately can cut
 * off buffered stdout, so a script that did most of its work and then failed
 * prints nothing about what it accomplished. Setting the code lets the process
 * end on its own once the write completes.
 */
export async function run(
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body()
  } catch (error) {
    fail(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack && process.env.DEBUG) {
      console.error(error.stack)
    }
    process.exitCode = 1
  }
}
