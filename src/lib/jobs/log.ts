import type { JobLogger, JobLogEvent } from './handlers'

/**
 * The worker's log format: one JSON object per line.
 *
 * Here rather than in either entry point because there are two of them now — the
 * CLI and the loop the server starts for itself — and a log an operator greps
 * has to look the same whichever one produced it. The line is the interface:
 * `ts`, a `level`, then the event's own fields, with the event name inside the
 * object rather than in front of it, so a collector can parse a line without
 * knowing anything about this application.
 *
 * `process.stdout.write` rather than `console.log`. The line is already
 * formatted; `console` would add its own inspection on the way out, and the one
 * thing a machine-readable line must not have is a second printer's opinion of
 * it. Errors go to stderr and the rest to stdout, which is the split the CLI has
 * always made and the split the server it now shares a process with makes too.
 */
export function jsonLineLogger(): JobLogger {
  const write = (level: 'info' | 'error', event: JobLogEvent): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, ...event })
    const stream = level === 'error' ? process.stderr : process.stdout
    stream.write(`${line}\n`)
  }

  return {
    info: (event) => write('info', event),
    error: (event) => write('error', event),
  }
}
