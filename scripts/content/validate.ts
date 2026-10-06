import fs from 'node:fs/promises'
import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { flagBool, heading, info, parseArgs, report, run, style, warn } from '../lib/cli'

/**
 * Check every document in the content tree, writing nothing.
 *
 * The check is the import engine's, run in place instead of against a batch.
 * That is deliberate: "is this file valid" has exactly one answer in this
 * codebase — the schema in `src/lib/content/schema.ts`, wrapped by the rules the
 * importer adds around it — and a second implementation here would drift from it
 * within a release. Feeding the tree back through the importer is also what
 * makes the report cover the things a schema cannot see: a slug two files both
 * claim, a link to a document that does not exist, an unknown frontmatter key.
 *
 * Nothing is written, and nothing is fixed. The title fix that the import CLI
 * can apply is left off, because deriving a title for a file that is already in
 * the tree would mean rewriting it — which is an editor's decision, not a
 * linter's.
 *
 * Exit code 1 when any file is invalid. Warnings do not fail the run: a note
 * without a date is a draft, not an error, and a check that fails on drafts is
 * a check nobody runs.
 */
const args = parseArgs(process.argv.slice(2))
const showAll = flagBool(args, 'all')

const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

void run('content:validate', async () => {
  const { env } = await import('@/env')
  const { scanContentFiles } = await import('@/lib/content/reader')
  const {
    IMPORT_LIMITS,
    collectExistingContent,
    collectUploadKeys,
    inspectImportEntries,
  } = await import('@/lib/content/import')

  heading('Validating content')

  const scanned = await scanContentFiles({ maxFiles: env.CONTENT_MAX_FILES + 1 })
  const truncated = scanned.length > env.CONTENT_MAX_FILES
  const files = scanned.slice(0, env.CONTENT_MAX_FILES)
  if (truncated) {
    // Loud, because the report below claims to cover the tree and would not.
    warn(
      `The scan stopped at ${env.CONTENT_MAX_FILES} files (CONTENT_MAX_FILES); ` +
        'documents past the limit were not checked. Raise it and run again for a complete answer.',
    )
    process.exitCode = 1
  }

  const existing = await collectExistingContent()
  const images = await collectUploadKeys()

  let batchBytes = 0
  const entries = []
  for (const file of files) {
    const bytes = await fs.readFile(file.absolutePath).catch(() => null)
    if (bytes) batchBytes += bytes.length
    entries.push({ sourcePath: file.relativePath, bytes, inferredType: file.type })
  }

  const candidates = inspectImportEntries(entries, {
    // Only reached by a file whose path names no type, which the scanner cannot
    // produce: everything it returns lives under `posts/`, `notes/` or
    // `projects/`. It is here so the option has no silent default.
    type: 'post',
    knownTargets: existing.targets,
    knownImages: images,
    // The batch caps belong to an import of files from elsewhere, not to a tree
    // that is already here: a site with 400 documents is over the file cap and
    // its total size is over the byte cap by definition, and reporting either as
    // a problem would make this command useless on exactly the sites that need
    // it. The per-file cap stays, because a 5 MB Markdown file is a problem
    // wherever it lives.
    maxFiles: files.length,
    maxBatchBytes: Math.max(batchBytes, IMPORT_LIMITS.maxBatchBytes),
  })

  const invalid = candidates.filter((candidate) => candidate.action === 'reject')
  const withProblems = candidates.filter((candidate) => candidate.problems.length > 0)

  const tally = { error: 0, warning: 0, info: 0 }
  let brokenLinks = 0
  for (const candidate of candidates) {
    for (const problem of candidate.problems) {
      tally[problem.severity] += 1
      if (problem.code === 'broken-link' || problem.code === 'broken-image') brokenLinks += 1
    }
  }

  if (withProblems.length > 0) {
    heading('Problems')
    for (const candidate of withProblems) {
      console.log(`\n  ${style.bold(candidate.sourcePath)}`)
      for (const problem of candidate.problems) {
        const mark =
          problem.severity === 'error'
            ? style.red('✗')
            : problem.severity === 'warning'
              ? style.yellow('⚠')
              : style.dim('·')
        const where = problem.line !== undefined ? style.dim(`line ${problem.line}  `) : ''
        console.log(`    ${mark} ${where}${problem.message}`)
        console.log(`      ${style.dim(problem.suggestion)}`)
      }
    }
    console.log('')
  }

  if (showAll && candidates.length > withProblems.length) {
    heading('Clean')
    for (const candidate of candidates) {
      if (candidate.problems.length > 0) continue
      info(`${style.green('✓')} ${candidate.sourcePath}  ${style.dim(candidate.title)}`)
    }
  }

  heading('Summary')
  report({
    'Files checked': candidates.length,
    Invalid: invalid.length,
    Errors: tally.error,
    Warnings: tally.warning,
    Notes: tally.info,
    'Broken links': brokenLinks,
  })

  if (invalid.length > 0) {
    warn('Invalid files cannot be indexed or imported. Fix them, then run `pnpm content:sync`.')
    process.exitCode = 1
  } else if (!truncated) {
    info(style.green(`All ${candidates.length} files are valid.`))
  }
})
