import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from '@playwright/test'
import sharp from 'sharp'

import { E2E_CONTENT_DIR, E2E_UPLOAD_DIR, hasE2eDatabase, serverEnv } from './environment'
import { uniqueSlug } from './support'

test.skip(!hasE2eDatabase, 'TEST_DATABASE_URL is required for the isolated E2E database.')

// One 16px VP8 frame in a WebM container. Keeping the tiny playable fixture here
// avoids requiring a video encoder on machines that run the browser suite.
const VIDEO = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAINEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHF' +
    'O7a1OsggH37AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAaQAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIFLOu90nTAsOcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIFLOu90nTAsNnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMjAwMDAwMDAwAB9DtnXB54EAo7yBAACAsAIAnQEqEAAQAABHCIWFiIWEiAICAnWqA/gCDP0oAP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gAcU7trkbuPs4EAt4r3gQHxggGx8IED',
  'base64',
)

function syncFixture(): void {
  execFileSync(
    path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    ['--conditions=react-server', 'scripts/content/sync.ts', '--hash-all'],
    { cwd: process.cwd(), env: serverEnv(), stdio: 'pipe', timeout: 30_000 },
  )
}

test('a public rich Markdown article renders safely and enhances in the browser', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000)
  const slug = `renderer-${uniqueSlug()}`
  const file = path.join(E2E_CONTENT_DIR, 'posts', `${slug}.md`)
  const media = path.join(E2E_UPLOAD_DIR, slug)
  const imageUrl = `/api/assets/${slug}/picture.png`
  const videoUrl = `/api/assets/${slug}/clip.webm`
  const sourceCode = `const answer = 42\nconst wide = "${'long-line-'.repeat(60)}"\n`
  const body = [
    '## Rich article',
    'Inline $a^2 + b^2 = c^2$ and a note[^reader].',
    '$$\n\\int_0^1 x^2 dx\n$$',
    '| Feature | Result |\n| --- | --- |\n| Markdown | Readable |',
    '> Ordinary quotation.',
    '- [x] Renderer integrated\n- [ ] More writing',
    '> [!TIP]\n> Alert remains readable.',
    ':::warning{title="Careful writing"}\nCallout body.\n:::',
    ':::details[Extra detail]\nThis detail can be opened.\n:::',
    'Publishing\n: A readable definition.',
    'Press :kbd[Ctrl] + :kbd[S].',
    ':::file-tree\nsrc/index.ts\nsrc/lib/db.ts\n:::',
    `![Renderer picture](${imageUrl})`,
    `::video{src="${videoUrl}" poster="${imageUrl}"}`,
    `::embed{src="https://www.youtube.com/embed/e2e-${slug}" title="Allowed renderer frame"}`,
    '```ts title="src/answer.ts" {2} /answer/ showLineNumbers\n' + sourceCode + '```',
    '```diff\n- old value\n+ new value\n```',
    '```bash terminal\n$ echo ready\nready\n```',
    '::::tabs\n:::tab[Install]\nInstall panel text.\n:::\n\n:::tab[Use]\nUse panel text.\n:::\n::::',
    '```mermaid\ngraph TD\n  A[Renderer] --> B[Browser]\n```',
    '```mermaid\nnot a supported diagram @@@\n```',
    '## Malformed and untrusted input',
    'Unmatched **formatting and [a broken link( still leaves this paragraph readable.',
    '<script>globalThis.__rendererXss = 1</script>',
    `<img src="/api/assets/${slug}/missing.png" onerror="globalThis.__rendererXss = 2" alt="Untrusted image">`,
    '<a href="javascript:globalThis.__rendererXss=3" onclick="globalThis.__rendererXss=4">Unsafe link</a>',
    '<iframe src="https://evil.example/steal" title="Unsafe renderer frame"></iframe>',
    '::embed{src="//evil.example/steal" title="Unsafe directive frame"}',
    '[^reader]: A useful footnote.',
  ].join('\n\n')

  await fs.mkdir(media, { recursive: true })
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(path.join(media, 'picture.png'), await sharp({
      create: { width: 48, height: 32, channels: 3, background: '#5a7191' },
    }).png().toBuffer())
    await fs.writeFile(path.join(media, 'clip.webm'), VIDEO)
    await fs.writeFile(file, `---\ntitle: Renderer ${slug}\nslug: ${slug}\nstatus: published\ndate: 2026-01-01\ndescription: Browser acceptance fixture for rich Markdown.\n---\n\n${body}\n`)
    syncFixture()

    // The iframe still traverses the real renderer and production CSP, but its
    // document is fulfilled locally so this test never needs a video service.
    await page.route('https://www.youtube.com/embed/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<p>Allowed embedded fixture</p>',
    }))
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const response = await page.goto(`/posts/${slug}`)
    expect(response?.status()).toBe(200)
    const html = await response!.text()
    for (const marker of ['class="katex"', 'md-tabs', 'md-details', 'src/answer.ts']) {
      expect(html, `${marker} is already present in the server response`).toContain(marker)
    }

    const article = page.locator('[data-article-body]')
    await expect(article.getByRole('heading', { level: 2, name: /Rich article/ })).toBeVisible()
    await expect(article.locator('.katex-display')).toBeVisible()
    await expect(article.locator('math')).toHaveCount(2)
    await expect(article.locator('table')).toContainText('Readable')
    await expect(article.locator('blockquote')).toContainText('Ordinary quotation')
    await expect(article.locator('input[type="checkbox"]:checked')).toHaveCount(1)
    await expect(article.locator('[data-footnotes]')).toContainText('A useful footnote')
    await expect(article.locator('.md-callout--tip')).toContainText('Alert remains readable')
    await expect(article.locator('.md-callout--warning')).toContainText('Careful writing')
    await expect(article.locator('dl')).toContainText('A readable definition')
    await expect(article.locator('kbd')).toHaveText(['Ctrl', 'S'])
    await expect(article.locator('.md-file-tree')).toContainText('src/lib/db.ts')

    const detail = article.locator('details')
    await expect(detail.getByText('This detail can be opened')).toBeHidden()
    await detail.locator('summary').click()
    await expect(detail.getByText('This detail can be opened')).toBeVisible()

    const picture = article.getByRole('img', { name: 'Renderer picture', exact: true })
    await picture.scrollIntoViewIfNeeded()
    await expect.poll(() => picture.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(48)
    const video = article.locator('video')
    await expect(video).toHaveAttribute('src', videoUrl)
    await expect(video).toHaveAttribute('controls', '')
    await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBe(16)
    const frame = article.getByTitle('Allowed renderer frame', { exact: true })
    await frame.scrollIntoViewIfNeeded()
    await expect(page.frameLocator('iframe[title="Allowed renderer frame"]').getByText('Allowed embedded fixture')).toBeVisible()

    const code = article.locator('.code-block').filter({ hasText: 'src/answer.ts' })
    await expect(code.locator('.code-block__badge')).toHaveText('ts')
    await expect(code.locator('.code-line.is-highlighted')).toHaveAttribute('data-line', '2')
    await expect(code.locator('.code-word-highlight')).toHaveText('answer')
    await expect(code.locator('pre')).toHaveClass(/has-line-numbers/)
    await code.getByRole('button', { name: 'Copy src/answer.ts' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sourceCode)
    await expect(article.locator('.is-diff-add')).toContainText('+ new value')
    await expect(article.locator('.is-diff-remove')).toContainText('- old value')
    await expect(article.locator('.is-terminal')).toContainText('ready')

    const tabs = article.locator('.md-tabs')
    await expect(tabs).toHaveAttribute('data-enhanced', 'true')
    const install = tabs.getByRole('tab', { name: 'Install', exact: true })
    const use = tabs.getByRole('tab', { name: 'Use', exact: true })
    await expect(tabs.getByText('Use panel text.')).toBeHidden()
    await install.focus()
    await page.keyboard.press('ArrowRight')
    await expect(use).toBeFocused()
    await expect(use).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.getByText('Use panel text.')).toBeVisible()
    await expect(tabs.getByText('Install panel text.')).toBeHidden()
    await page.keyboard.press('Home')
    await expect(install).toBeFocused()
    await expect(install).toHaveAttribute('tabindex', '0')
    await expect(use).toHaveAttribute('tabindex', '-1')

    const diagrams = article.locator('.mermaid-block')
    await expect(diagrams.first().locator('svg')).toBeVisible({ timeout: 20_000 })
    await expect(diagrams.first()).toHaveAttribute('data-processed', 'true')
    await expect(diagrams.first()).toContainText('Browser')
    await expect(diagrams.last()).toHaveAttribute('data-error', 'true')
    await expect(diagrams.last().locator('.mermaid-block__source')).toHaveText('not a supported diagram @@@\n')

    await expect(article).toContainText('still leaves this paragraph readable')
    await expect(article.locator('script, [onerror], [onclick], a[href^="javascript:"]')).toHaveCount(0)
    await expect(article.locator('iframe')).toHaveCount(1)
    expect(await page.evaluate(() => (window as Window & { __rendererXss?: number }).__rendererXss)).toBeUndefined()

    // Check the final enhanced layout, including the deliberately wide code.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    expect(await code.locator('pre').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  } finally {
    await fs.rm(file, { force: true })
    await fs.rm(media, { recursive: true, force: true })
    syncFixture()
  }
})
