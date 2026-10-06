import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { CONTENT_ROOT, RECOVERY_DIR, documentPath } from './paths'
import { assertNoSymlinkPath, joinRuntimePath } from '@/lib/security/paths'

const snapshotName = /^[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9-]{36}\.snapshot$/
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)

/** Persist the exact old bytes before a formal mutation can replace them. */
export async function preservePreviousContent(relativePath: string, raw: string): Promise<string> {
  documentPath(relativePath)
  await assertNoSymlinkPath(CONTENT_ROOT, RECOVERY_DIR, 'recovery directory')
  await fs.mkdir(RECOVERY_DIR, { recursive: true, mode: 0o700 })
  await assertNoSymlinkPath(CONTENT_ROOT, RECOVERY_DIR, 'recovery directory')
  await fs.chmod(RECOVERY_DIR, 0o700)

  const name = `${digest(relativePath)}-${digest(raw)}-${randomUUID()}.snapshot`
  const target = joinRuntimePath(RECOVERY_DIR, name)
  const temporary = joinRuntimePath(RECOVERY_DIR, `.tmp-${randomUUID()}`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    await assertNoSymlinkPath(CONTENT_ROOT, temporary, 'recovery staging file')
    handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(raw, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, target)
    await syncRecoveryDirectory()
    return `.recovery/${name}`
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
    await fs.unlink(target).catch(() => undefined)
    throw error
  }
}

/** Remove only an owned snapshot after its history is confirmed elsewhere. */
export async function discardRecoverySnapshot(relativePath: string | null | undefined): Promise<void> {
  if (!relativePath) return
  const name = relativePath.startsWith('.recovery/') ? relativePath.slice('.recovery/'.length) : ''
  if (!snapshotName.test(name)) throw new Error('Not a recovery snapshot path')
  const target = joinRuntimePath(RECOVERY_DIR, name)
  try {
    await assertNoSymlinkPath(CONTENT_ROOT, target, 'recovery snapshot')
    await fs.unlink(target)
    await syncRecoveryDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    // Keeping an extra private copy is safe; a cleanup failure must not turn a
    // confirmed save into a refused save.
    console.error('[content] recovery snapshot cleanup failed:', relativePath, error)
  }
}

async function syncRecoveryDirectory(): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(RECOVERY_DIR, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'EBADF', 'EISDIR', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    // Directory fsync is unsupported on some platforms; file fsync above is
    // still required before the original document may be replaced.
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}
