import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { flagBool, flagString, heading, info, parseArgs, report, run, style, warn } from '../lib/cli'

/**
 * Import Markdown from somewhere else, over the engine in
 * `src/lib/content/import.ts`.
 *
 * Three sources, one pipeline:
 *
 *   --from a.md,b.md     files that are already on this machine
 *   --zip export.zip     a ZIP archive
 *   --scan-dir ~/blog    a directory tree, walked in place
 *
 * The default is a **dry run**. `--apply` is what writes, and it has to be typed
 * out, because the failure mode of getting this wrong is a batch of documents
 * landing in the content tree under slugs nobody chose. Nothing is written in any
 * case until the report has been built from the actual bytes: the source files
 * are read-only for this command, and a "fix" is written into the copy in the
 * content tree, never into the file it came from.
 *
 * Exit code: non-zero when the scan itself failed, when every file was rejected
 * (there was nothing to do and the run should not look like a success), or when
 * `--apply` could not write something. A dry run that would import files exits 0
 * and says, in as many words, that it wrote nothing.
 */

/**
 * Flags that take a value.
 *
 * `parseArgs` spells those `--flag=value`, which is right for a flag whose value
 * is usually a word (`--type=post`). A path is almost always typed with a space,
 * and `--scan-dir /tmp/in` under that parser puts the path in `positional` and
 * leaves the flag as `true` — where it would be read as another `--from` and
 * fail with "EISDIR: illegal operation on a directory". So the three path flags
 * accept both spellings; anything else keeps the single spelling, so there is
 * still one way to write `--type`.
 */
const VALUE_FLAGS = new Set(['from', 'zip', 'scan-dir'])

function withSpacedValues(argv: readonly string[]): string[] {
  const rewrapped: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const name = arg.startsWith('--') ? arg.slice(2) : ''
    const next = argv[index + 1]

    if (name && VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      rewrapped.push(`--${name}=${next}`)
      index += 1
      continue
    }
    rewrapped.push(arg)
  }
  return rewrapped
}

const args = parseArgs(withSpacedValues(process.argv.slice(2)))

for (const name of VALUE_FLAGS) {
  if (args.flags[name] === true) {
    console.error(`${style.red('error')} --${name} needs a value: --${name} <path>`)
    process.exit(2)
  }
}

const apply = flagBool(args, 'apply')
const overwrite = flagBool(args, 'overwrite')
const titleFix = flagBool(args, 'title-fix')
const zipPath = flagString(args, 'zip')
const scanDir = flagString(args, 'scan-dir')
const typeFlag = flagString(args, 'type')
const fromFlag = flagString(args, 'from')

if (typeFlag !== undefined && !['post', 'note', 'project'].includes(typeFlag)) {
  console.error(`${style.red('error')} --type must be post, note or project (got “${typeFlag}”)`)
  process.exit(2)
}

/** Every positional argument and every comma-separated `--from` entry. */
const fromPaths = [
  ...args.positional,
  ...(fromFlag === undefined ? [] : fromFlag.split(',')),
]
  .map((value) => value.trim())
  .filter((value) => value.length > 0)

const sourcesChosen =
  [zipPath !== undefined, scanDir !== undefined, fromPaths.length > 0].filter(Boolean).length

if (sourcesChosen === 0) {
  console.error(
    `${style.red('error')} Nothing to import. Pass --from <file[,file]>, --zip <archive.zip> or --scan-dir <directory>.`,
  )
  process.exit(2)
}

if (sourcesChosen > 1) {
  console.error(
    `${style.red('error')} --zip, --scan-dir and --from are alternatives; only one source per run.`,
  )
  process.exit(2)
}

const type = typeFlag === undefined ? 'post' : (typeFlag as 'post' | 'note' | 'project')

const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

void run('content:import', async () => {
  const { IMPORT_LIMITS, applyImport, collectExistingContent, collectUploadKeys, importReportLines, scanImportArchive, scanImportDirectory, scanImportFiles } =
    await import('@/lib/content/import')
  const { formatBytes } = await import('@/lib/utils/format')

  heading('Scanning')

  // One set of options for every source, so the three cannot disagree about what
  // a conflict is or which links resolve. `overwrite` is in here rather than at
  // the three call sites because forgetting it at one of them is exactly how
  // `--scan-dir --overwrite` came to accept the flag and skip anyway.
  const existing = await collectExistingContent()
  const images = await collectUploadKeys()
  const options = {
    type,
    // An explicit `--type` overrides what the source layout says, because that is
    // what was asked for; the report shows which entries it changed.
    ...(typeFlag !== undefined ? { forceType: true } : {}),
    existing: existing.slugs,
    knownTargets: existing.targets,
    knownImages: images,
    applyTitleFix: titleFix,
    overwrite,
  }

  const plan = await (async () => {
    if (zipPath !== undefined) {
      const buffer = await fs.readFile(zipPath).catch((error: unknown) => {
        throw new Error(
          `Cannot read ${zipPath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      info(`${path.basename(zipPath)} (${formatBytes(buffer.length)})`)
      return scanImportArchive(buffer, { ...options, source: path.resolve(zipPath) })
    }

    if (scanDir !== undefined) {
      info(path.resolve(scanDir))
      return scanImportDirectory(scanDir, { ...options, source: path.resolve(scanDir) })
    }

    const files = []
    for (const value of fromPaths) {
      const absolute = path.resolve(value)
      // Stat before reading. The other order made the sentence below unreachable:
      // `readFile` throws EISDIR on a directory first, so `--from ~/blog` — the
      // mistake this message exists for — answered with a bare errno.
      const stat = await fs.stat(absolute).catch((error: unknown) => {
        throw new Error(
          `Cannot read ${value}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      if (!stat.isFile()) throw new Error(`${value} is not a file. Use --scan-dir for a directory.`)
      const data = await fs.readFile(absolute).catch((error: unknown) => {
        throw new Error(
          `Cannot read ${value}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      if (data.length > IMPORT_LIMITS.maxFileBytes) {
        // Refused here as well as in the engine so the message names the flag.
        throw new Error(
          `${value} is ${formatBytes(data.length)}, over the ${formatBytes(IMPORT_LIMITS.maxFileBytes)} per-file limit.`,
        )
      }
      files.push({ name: path.basename(absolute), data })
    }
    info(`${files.length} file${files.length === 1 ? '' : 's'}`)
    return scanImportFiles(files, { ...options, source: fromPaths.join(', ') })
  })()

  heading('Report')
  for (const line of importReportLines(plan)) console.log(`  ${line}`)

  if (plan.problems.length > 0) {
    console.log('')
    for (const problem of plan.problems) {
      warn(`${problem.path ?? plan.source}: ${problem.message}`)
      info(style.dim(problem.suggestion))
    }
  }

  const notable = plan.entries.filter((entry) => entry.problems.length > 0)
  if (notable.length > 0) {
    heading('Per file')
    for (const entry of notable) {
      const mark =
        entry.action === 'reject'
          ? style.red('✗')
          : entry.action === 'skip'
            ? style.dim('·')
            : style.green('✓')
      console.log(`\n  ${mark} ${style.bold(entry.sourcePath)}`)
      console.log(
        `    ${style.dim(
          `${entry.action} → ${entry.targetPath}  (${entry.type} from ${entry.typeSource}, ${entry.status})`,
        )}`,
      )
      for (const problem of entry.problems) {
        const where = problem.line !== undefined ? style.dim(`line ${problem.line}  `) : ''
        const severity =
          problem.severity === 'error'
            ? style.red('error')
            : problem.severity === 'warning'
              ? style.yellow('warning')
              : style.dim('note')
        console.log(`    ${severity}  ${where}${problem.message}`)
        console.log(`      ${style.dim(problem.suggestion)}`)
      }
    }
    console.log('')
  }

  const importable = plan.entries.filter(
    (entry) => entry.action === 'create' || entry.action === 'overwrite',
  )

  if (!apply) {
    heading('Dry run')
    report({
      'Would import': plan.counts.create + plan.counts.overwrite,
      'Would overwrite': plan.counts.overwrite,
      'Would skip': plan.counts.skip,
      Rejected: plan.counts.reject,
    })
    info(style.green('Nothing was written.'))
    info(`Re-run with ${style.bold('--apply')} to write these files into the content tree.`)
    // Nothing at all importable is a failed run, not a quiet success: every file
    // was refused, and an exit code of 0 would tell a script the opposite.
    if (plan.entries.length > 0 && importable.length === 0) {
      warn('Every file was rejected; there is nothing to apply.')
      process.exitCode = 1
    }
    return
  }

  heading('Applying')

  const result = await applyImport(plan, {
    applyFixes: titleFix,
    onEvent: (event) => {
      switch (event.kind) {
        case 'created':
          info(`${style.green('+')} ${event.targetPath}  ${style.dim(event.sourcePath)}`)
          break
        case 'overwritten':
          info(`${style.cyan('~')} ${event.targetPath}  ${style.dim(event.sourcePath)}`)
          break
        case 'skipped':
          info(`${style.dim('·')} ${event.targetPath}  ${style.dim(event.reason)}`)
          break
        case 'failed':
          warn(`${event.sourcePath}: ${event.message}`)
          break
      }
    },
  })

  heading('Summary')
  report({
    Created: result.created,
    Overwritten: result.overwritten,
    Skipped: result.skipped,
    Rejected: result.rejected,
    Failed: result.failed,
    Duration: `${result.durationMs}ms`,
  })

  const written = result.files.filter(
    (file) => file.outcome === 'created' || file.outcome === 'overwritten',
  )

  if (written.length > 0) {
    info(
      `Run ${style.bold('pnpm content:sync')} to index what was written; the files are on disk either way.`,
    )
  }

  if (result.failed > 0) {
    warn('Some files were not written. The summary above says which; nothing else was affected.')
    process.exitCode = 1
  }
})
