import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { contentIndex } from '@/lib/db/schema'
import { syncContent } from '@/lib/content/sync'
import { hasTestDatabase, testContentRoot } from '../setup'

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
function runCli(command: string, limit = '1'): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [tsxCli, '--conditions=react-server', `scripts/content/${command}.ts`], {
      cwd: process.cwd(),
      env: { ...process.env, CONTENT_DIR: testContentRoot, CONTENT_MAX_FILES: limit },
    }, (error, stdout, stderr) => resolve({
      code: error ? Number(error.code) || 1 : 0,
      output: stdout + stderr,
    }))
  })
}

describe.skipIf(!hasTestDatabase)('content CLI completeness safeguards', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    await db.delete(contentIndex)
    await fs.mkdir(path.join(testContentRoot, 'posts'), { recursive: true })
    for (const slug of ['first', 'second']) {
      await fs.writeFile(path.join(testContentRoot, `posts/${slug}.md`),
        `---\ntitle: ${slug}\nslug: ${slug}\ndescription: Test document\ndate: 2026-01-01\n---\n\nBody.\n`)
    }
    await syncContent({ hashAll: true })
  })
  afterAll(async () => { await db.delete(contentIndex) })

  it('reports incomplete sync as failure and preserves every indexed file', async () => {
    const result = await runCli('sync')
    expect(result.code).toBe(1)
    expect(result.output).toContain('revision history were retained')
    expect(await db.select().from(contentIndex)).toHaveLength(2)
  })

  it('does not claim all files valid after a truncated validation', async () => {
    const result = await runCli('validate')
    expect(result.code).toBe(1)
    expect(result.output).toContain('documents past the limit were not checked')
    expect(result.output).not.toContain('files are valid')
  })

  it('does not claim no broken links when its source index cannot be verified completely', async () => {
    const result = await runCli('links')
    expect(result.code).toBe(1)
    expect(result.output).toContain('scan is incomplete')
    expect(result.output).not.toContain('No broken links.')
  })

  it('succeeds when every file exactly fits the configured scan cap', async () => {
    const result = await runCli('validate', '2')
    expect(result.code).toBe(0)
    expect(result.output).toContain('All 2 files are valid')
    expect(result.output).not.toContain('documents past the limit')
  })
})
