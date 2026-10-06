import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const toolsAvailable = ['bash', 'tar', 'zstd', 'realpath', 'flock'].every((tool) =>
  spawnSync(tool, ['--version']).status === 0,
)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkbranch-backup-test-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true })
  for (const file of ['backup.sh', 'restore.sh', 'lib/backup-common.sh']) {
    fs.copyFileSync(path.join(process.cwd(), 'scripts', file), path.join(root, 'scripts', file))
  }
  fs.mkdirSync(path.join(root, 'content/posts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'public/uploads'), { recursive: true })
  fs.writeFileSync(path.join(root, 'content/posts/original.md'), '# Original\n')
  fs.writeFileSync(path.join(root, 'public/uploads/image.png'), 'original-image')
  fs.writeFileSync(path.join(root, '.env'), "DATABASE_URL='postgresql://fixture:secret@localhost/fixture'\nSESSION_SECRET=fixture-secret\n")
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'pg_dump'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == --version ]]; then echo 'pg_dump fixture'; exit; fi
for arg in "$@"; do
  if [[ "$arg" == --file=* ]]; then printf fixture-dump > "\${arg#--file=}"; fi
done
printf '%s' "\${@: -1}" > "$DUMP_TARGET_LOG"
`, { mode: 0o700 })
  fs.writeFileSync(path.join(bin, 'pg_restore'), `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
if [[ "\${1:-}" == --list ]]; then exit; fi
if [[ "\${FAIL_RESTORE:-0}" == 1 ]]; then echo 'fixture database failure' >&2; exit 13; fi
`, { mode: 0o700 })
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DATABASE_URL: '', CONTENT_DIR: '', UPLOAD_DIR: '',
    DUMP_TARGET_LOG: path.join(root, 'dump-target'), BACKUP_KEEP: '0', BACKUP_LABEL: '',
  }
  const run = (script: string, args: string[] = [], extra: Record<string, string> = {}) =>
    execFileSync('bash', [path.join(root, 'scripts', script), ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' })
  const archive = () => {
    run('backup.sh')
    const name = fs.readdirSync(path.join(root, 'backups')).find((file) => file.endsWith('.tar.zst'))
    if (!name) throw new Error('backup did not publish an archive')
    return path.join(root, 'backups', name)
  }
  return { root, env, run, archive }
}

describe.runIf(toolsAvailable)('backup and restore scripts', () => {
  it('reads .env, protects the secret archive, and restores the local upload directory', () => {
    const { root, run, archive } = fixture()
    const saved = archive()
    expect(fs.readFileSync(path.join(root, 'dump-target'), 'utf8')).toBe('postgresql://fixture:secret@localhost/fixture')
    expect(fs.statSync(saved).mode & 0o077).toBe(0)
    fs.writeFileSync(path.join(root, 'content/posts/original.md'), '# Changed\n')
    fs.writeFileSync(path.join(root, 'public/uploads/image.png'), 'changed-image')
    run('restore.sh', [saved, '--yes'])
    expect(fs.readFileSync(path.join(root, 'content/posts/original.md'), 'utf8')).toBe('# Original\n')
    expect(fs.readFileSync(path.join(root, 'public/uploads/image.png'), 'utf8')).toBe('original-image')
    expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'config.restored/.env'), 'utf8')).toContain('SESSION_SECRET=fixture-secret')
    expect(fs.statSync(path.join(root, 'content')).uid).toBe(fs.statSync(path.join(root, 'content/posts/original.md')).uid)
  })

  it('matches dotenv duplicate-key rules and .env.local precedence without evaluating values', () => {
    const { root, run } = fixture()
    fs.writeFileSync(path.join(root, '.env.local'), "DATABASE_URL=postgresql://fixture:old@localhost/old\nDATABASE_URL='postgresql://fixture:last@localhost/current'\n")
    run('backup.sh')
    expect(fs.readFileSync(path.join(root, 'dump-target'), 'utf8')).toBe('postgresql://fixture:last@localhost/current')
    run('backup.sh', [], { DATABASE_URL: 'postgresql://fixture:exported@localhost/exported' })
    expect(fs.readFileSync(path.join(root, 'dump-target'), 'utf8')).toBe('postgresql://fixture:exported@localhost/exported')
  })

  it('rolls files and recovered config back when the database restore fails', () => {
    const { root, run, archive } = fixture()
    const saved = archive()
    fs.writeFileSync(path.join(root, 'content/posts/original.md'), '# Current\n')
    fs.writeFileSync(path.join(root, 'public/uploads/image.png'), 'current-image')
    fs.mkdirSync(path.join(root, 'config.restored'))
    fs.writeFileSync(path.join(root, 'config.restored/operator-note'), 'keep me')
    expect(() => run('restore.sh', [saved, '--yes'], { FAIL_RESTORE: '1' })).toThrow()
    expect(fs.readFileSync(path.join(root, 'content/posts/original.md'), 'utf8')).toBe('# Current\n')
    expect(fs.readFileSync(path.join(root, 'public/uploads/image.png'), 'utf8')).toBe('current-image')
    expect(fs.readFileSync(path.join(root, 'config.restored/operator-note'), 'utf8')).toBe('keep me')
    expect(fs.readdirSync(root).some((name) => name.includes('.before-'))).toBe(false)
  })

  it('retains the newest archive after numeric filename suffixes reach ten', () => {
    const { root, run, archive } = fixture()
    const original = archive()
    const ninth = original.replace('.tar.zst', '-9.tar.zst')
    const tenth = original.replace('.tar.zst', '-10.tar.zst')
    fs.copyFileSync(original, ninth)
    fs.copyFileSync(original, tenth)
    for (const [index, file] of [original, ninth, tenth].entries()) fs.utimesSync(file, 1000 + index, 1000 + index)
    run('backup.sh', [], { BACKUP_KEEP: '2' })
    const files = fs.readdirSync(path.join(root, 'backups')).filter((name) => name.endsWith('.tar.zst'))
    expect(files).toHaveLength(2)
    expect(files).toContain(path.basename(tenth))
    expect(files).not.toContain(path.basename(original))
    expect(files).not.toContain(path.basename(ninth))
  })

  it('refuses missing source trees and symlinked targets without replacing data', () => {
    const { root, run, archive } = fixture()
    const saved = archive()
    fs.renameSync(path.join(root, 'content'), path.join(root, 'real-content'))
    expect(() => run('backup.sh')).toThrow()
    fs.symlinkSync(path.join(root, 'real-content'), path.join(root, 'content'))
    expect(() => run('restore.sh', [saved, '--yes'])).toThrow()
    expect(fs.readFileSync(path.join(root, 'real-content/posts/original.md'), 'utf8')).toBe('# Original\n')
  })

  it('refuses archives containing symlinks before changing installed content', () => {
    const { root, run, archive } = fixture()
    const saved = archive()
    const extracted = path.join(root, 'malicious')
    fs.mkdirSync(extracted)
    execFileSync('tar', ['--extract', '--use-compress-program=zstd', '--file', saved, '-C', extracted])
    fs.symlinkSync('/etc/passwd', path.join(extracted, 'content/escape'))
    const unsafe = path.join(root, 'unsafe.tar.zst')
    execFileSync('tar', ['--create', '--use-compress-program=zstd', '--file', unsafe, '-C', extracted, 'content', 'uploads', 'config', 'MANIFEST', 'database.dump'])
    fs.writeFileSync(path.join(root, 'content/posts/original.md'), '# Current\n')
    expect(() => run('restore.sh', [unsafe, '--yes'])).toThrow()
    expect(fs.readFileSync(path.join(root, 'content/posts/original.md'), 'utf8')).toBe('# Current\n')
  })

  it('rejects an unsafe backup label before publishing an archive', () => {
    const { root, run } = fixture()
    expect(() => run('backup.sh', [], { BACKUP_LABEL: '../../outside' })).toThrow()
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false)
  })

  it('fails before replacing files when application ownership cannot be preserved', () => {
    const { root, run, archive } = fixture()
    const saved = archive()
    fs.writeFileSync(path.join(root, 'content/posts/original.md'), '# Current\n')
    fs.writeFileSync(path.join(root, 'bin/chown'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o700 })
    expect(() => run('restore.sh', [saved, '--yes'])).toThrow()
    expect(fs.readFileSync(path.join(root, 'content/posts/original.md'), 'utf8')).toBe('# Current\n')
    expect(fs.readdirSync(root).some((name) => name.includes('.before-'))).toBe(false)
  })
})
