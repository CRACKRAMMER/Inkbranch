import { describe, expect, it } from 'vitest'
import {
  FrontmatterError,
  frontmatterValueToString,
  isoDate,
  isoTimestamp,
  parseFrontmatter,
  replaceFrontmatter,
  serializeFrontmatter,
} from '@/lib/content/frontmatter'
import {
  flexibleDate,
  normaliseFrontmatterKeys,
  noteFrontmatterSchema,
  postFrontmatterSchema,
  projectFrontmatterSchema,
  splitFrontmatterKeys,
} from '@/lib/content/schema'
import {
  buildHeadingTree,
  deriveContent,
  extractHeadings,
  fallbackSlug,
  humanizeFilename,
  shouldShowToc,
  type Heading,
} from '@/lib/content/derive'

/**
 * These three modules sit between an author's Markdown files and everything the
 * site publishes, so a defect here loses writing rather than merely rendering it
 * oddly: an unclosed fence that swallows a body, a legacy key that never maps,
 * a date that lands on the wrong day. The tests below lean on those failure
 * modes rather than on the shape of the objects that come back.
 */

/** Capture whatever a call threw, so an error's class and message can be read. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected the call to throw, but it returned normally')
}

/** The recursive shape `buildHeadingTree` builds, which its return type flattens. */
interface NestedHeading extends Heading {
  children: NestedHeading[]
}

describe('parseFrontmatter', () => {
  it('separates the metadata block from the body', () => {
    const parsed = parseFrontmatter(
      '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Heading\n\nBody text.\n',
    )

    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.data).toEqual({ title: 'Hello', tags: ['a', 'b'] })
    expect(parsed.content).toBe('# Heading\n\nBody text.\n')
    expect(parsed.raw).toBe('title: Hello\ntags: [a, b]')
  })

  it('treats a file with no fence as pure body', () => {
    const source = '# Heading\n\nJust markdown.\n'
    const parsed = parseFrontmatter(source)

    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.data).toEqual({})
    expect(parsed.content).toBe(source)
  })

  it('keeps the whole file as body when the opening fence is never closed', () => {
    const source = '---\ntitle: Lost\n\nEverything here is body.\n'
    const parsed = parseFrontmatter(source)

    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.data).toEqual({})
    // Not one character may be dropped: a half-written file has to render as
    // its own text instead of vanishing from the site.
    expect(parsed.content).toBe(source)
  })

  it('reads a +++ block the way TOML-frontmatter generators write it', () => {
    const parsed = parseFrontmatter('+++\ntitle: TOML-ish\ntags:\n  - a\n+++\n\nBody.\n')

    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.data).toEqual({ title: 'TOML-ish', tags: ['a'] })
    expect(parsed.content).toBe('Body.\n')
  })

  it('keeps an unclosed +++ block in the body too', () => {
    const source = '+++\ntitle: TOML-ish\nno closing fence\n'
    const parsed = parseFrontmatter(source)

    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.content).toBe(source)
  })

  it('accepts the YAML document-end marker as a closing fence', () => {
    const parsed = parseFrontmatter('---\ntitle: Hello\n...\nBody.\n')

    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.data).toEqual({ title: 'Hello' })
    expect(parsed.content).toBe('Body.\n')
  })

  it('treats an empty block as frontmatter with no keys', () => {
    for (const source of ['---\n---\nBody.\n', '---\n\n---\nBody.\n']) {
      const parsed = parseFrontmatter(source)
      expect(parsed.hasFrontmatter).toBe(true)
      expect(parsed.data).toEqual({})
      expect(parsed.content).toBe('Body.\n')
    }
  })

  it('strips a UTF-8 BOM so the opening fence is still the first line', () => {
    const parsed = parseFrontmatter('\uFEFF---\ntitle: Hello\n---\nBody.\n')

    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.data).toEqual({ title: 'Hello' })
    // The BOM must not survive into the body either, where it would be glued to
    // the first character of the article.
    expect(parseFrontmatter('\uFEFF# Heading\n').content).toBe('# Heading\n')
  })

  it('normalises CRLF line endings', () => {
    const parsed = parseFrontmatter(
      '---\r\ntitle: Hello\r\n---\r\nLine one.\r\nLine two.\r\n',
    )

    expect(parsed.data).toEqual({ title: 'Hello' })
    expect(parsed.content).toBe('Line one.\nLine two.\n')
  })

  it('closes on the first fence, leaving later --- lines in the body', () => {
    const parsed = parseFrontmatter('---\ntitle: T\n---\n\nAbove.\n\n---\n\nBelow.\n')

    expect(parsed.content).toBe('Above.\n\n---\n\nBelow.\n')
  })

  it('reads lists, nested maps, booleans, numbers and dates out of YAML', () => {
    const parsed = parseFrontmatter(
      '---\ntags:\n  - linux\n  - zsh\nseo:\n  noindex: true\nfeatured: false\nweight: 3\ndate: 2026-09-11\n---\nBody.\n',
    )

    expect(parsed.data).toEqual({
      tags: ['linux', 'zsh'],
      seo: { noindex: true },
      featured: false,
      weight: 3,
      // YAML's core schema leaves a bare date as text; `flexibleDate` is what
      // turns it into the calendar day the author meant.
      date: '2026-09-11',
    })
    expect(flexibleDate.parse(parsed.data.date).toISOString()).toBe(
      '2026-09-11T12:00:00.000Z',
    )
  })

  it('reports malformed YAML as a FrontmatterError naming the problem', () => {
    const bad = () => parseFrontmatter('---\ntitle: [unclosed\n---\nBody.\n')

    expect(bad).toThrow(FrontmatterError)
    expect(bad).toThrow(/Invalid YAML in frontmatter/)
  })

  it('rejects a block that is a list rather than a mapping', () => {
    const error = captureThrow(() => parseFrontmatter('---\n- one\n- two\n---\nBody.\n'))

    expect(error).toBeInstanceOf(FrontmatterError)
    expect((error as FrontmatterError).message).toMatch(/mapping of keys to values/)
    // The reader turns this code into a reader-facing message, so it is part of
    // the module's contract rather than an implementation detail.
    expect((error as FrontmatterError).code).toBe('FRONTMATTER')
  })
})

describe('serializeFrontmatter', () => {
  it('round-trips every value shape through parse → serialize → parse', () => {
    const original = {
      title: 'Round trip: colons, "quotes" & unicode — 日本語',
      slug: '123',
      description: 'first line\nsecond line\n\nwith a blank line',
      date: '2026-09-11',
      tags: ['linux', '日本語'],
      featured: false,
      toc: true,
      weight: 3,
      nested: { noindex: true, depth: [1, 2] },
    }

    const readBack = parseFrontmatter(serializeFrontmatter(original, 'Body.\n')).data

    expect(readBack).toEqual(original)
  })

  it('writes a string that looks like a number as a string', () => {
    const written = serializeFrontmatter({ title: 'T', slug: '123' }, '')

    expect(parseFrontmatter(written).data.slug).toBe('123')
  })

  it('writes a Date as an ISO timestamp that reads back as the same instant', () => {
    const written = serializeFrontmatter(
      { title: 'T', updated: new Date('2026-09-20T08:30:00.000Z') },
      'Body.',
    )
    const readBack = parseFrontmatter(written).data.updated

    expect(readBack).toBe('2026-09-20T08:30:00.000Z')
    expect(flexibleDate.parse(readBack).getTime()).toBe(Date.UTC(2026, 8, 20, 8, 30))
  })

  it('writes the canonical keys first and the unknown ones last', () => {
    const written = serializeFrontmatter(
      { tags: ['a'], title: 'T', mood: 'calm', date: '2026-09-11' },
      'Body.',
    )
    const lines = written.split('\n')
    const position = (line: string) => lines.indexOf(line)

    expect(position('title: "T"')).toBeLessThan(position('date: "2026-09-11"'))
    expect(position('date: "2026-09-11"')).toBeLessThan(position('tags:'))
    // A key the app knows nothing about is still kept, after the known ones.
    expect(position('mood: "calm"')).toBeGreaterThan(position('tags:'))
  })

  it('leaves out the keys that carry no information', () => {
    const written = serializeFrontmatter(
      { title: 'T', description: '', tags: [], series: undefined, cover: null, seo: {} },
      'Body.',
    )

    for (const key of ['description', 'tags', 'series', 'cover', 'seo']) {
      expect(written).not.toContain(key)
    }
    expect(written).toContain('title: "T"')
  })

  it('keeps false for the flags where false changes what a reader sees', () => {
    const written = serializeFrontmatter({ title: 'T', featured: false, toc: false }, 'Body.')

    expect(written).toContain('featured: false')
    expect(written).toContain('toc: false')
  })

  it('keeps keys it does not understand instead of dropping them', () => {
    const written = serializeFrontmatter(
      { title: 'T', mood: 'calm', rating: 5 },
      'Body.',
      { extra: { importedFrom: 'ghost' } },
    )

    expect(parseFrontmatter(written).data).toMatchObject({
      mood: 'calm',
      rating: 5,
      importedFrom: 'ghost',
    })
  })

  it('separates the block from the body so the first line is not swallowed', () => {
    // `---` with text straight after it would run that text into the block; the
    // blank line is what keeps the body a body.
    const written = serializeFrontmatter({ title: 'T' }, '# Heading\n\nBody.\n')

    expect(written.endsWith('---\n\n# Heading\n\nBody.\n')).toBe(true)
  })

  it('writes a comment inside the block, where it cannot hide the metadata', () => {
    const written = serializeFrontmatter({ title: 'T' }, 'Body.', {
      comment: 'managed by myblog',
    })

    // Inside the fences, not above them: a line before the opening `---` is not
    // skipped by the parser, so the whole block would read back as body text
    // and the metadata would be silently gone.
    expect(written.startsWith('---\n# managed by myblog\n')).toBe(true)

    const readBack = parseFrontmatter(written)
    expect(readBack.hasFrontmatter).toBe(true)
    expect(readBack.data).toEqual({ title: 'T' })
    expect(readBack.content).toBe('Body.\n')
  })

  it('keeps the body byte-identical when a comment is written', () => {
    const body = '# Heading\n\nSome *text*.\n'
    const written = serializeFrontmatter({ title: 'T' }, body, { comment: 'generated' })
    expect(parseFrontmatter(written).content).toBe(body)
  })

  it('does not wrap a long CJK description across lines', () => {
    const description = '日本語のテキストを長くして折り返しを確認する。'.repeat(8)

    const written = serializeFrontmatter({ title: 'T', description }, 'Body.')

    expect(parseFrontmatter(written).data.description).toBe(description)
  })
})

describe('replaceFrontmatter', () => {
  it('replaces the metadata and leaves the article body byte-identical', () => {
    const source = [
      '---',
      'title: Old',
      'tags: [old]',
      '---',
      '',
      '# Keep me',
      '',
      '```ts',
      'const a = 1  ',
      '```',
      '',
      'A paragraph  ',
      'continued.',
      '',
    ].join('\n')

    const updated = replaceFrontmatter(source, { title: 'New', tags: ['new'] })

    expect(parseFrontmatter(updated).data).toEqual({ title: 'New', tags: ['new'] })
    // The body never round-trips through a parser: what the author typed stays
    // on disk, down to the two spaces that mean a hard line break.
    expect(updated.slice(updated.indexOf('---\n\n') + 5)).toBe(
      '# Keep me\n\n```ts\nconst a = 1  \n```\n\nA paragraph  \ncontinued.\n',
    )
  })

  it('adds a block to a file that had none', () => {
    const updated = replaceFrontmatter('# Heading\n\nBody.\n', { title: 'New' })

    expect(parseFrontmatter(updated).data).toEqual({ title: 'New' })
    expect(parseFrontmatter(updated).content).toBe('# Heading\n\nBody.\n')
  })

  it('does not duplicate the body when the file ends with blank lines', () => {
    const updated = replaceFrontmatter('---\ntitle: T\n---\n\nLast line.\n\n\n', {
      title: 'N',
    })

    expect(parseFrontmatter(updated).content).toBe('Last line.\n')
    expect(updated.match(/Last line\./g)).toHaveLength(1)
    // Exactly one block: rewriting metadata must never append a second one.
    expect(updated.match(/^---$/gm)).toHaveLength(2)
  })
})

describe('isoDate / isoTimestamp', () => {
  it('formats the day in UTC so the stored date never shifts', () => {
    // 23:30 UTC is already tomorrow in Tokyo and still today in Los Angeles;
    // the stored day has to be the same for both readers.
    expect(isoDate(new Date(Date.UTC(2026, 8, 11, 23, 30)))).toBe('2026-09-11')
    expect(isoDate(new Date(Date.UTC(2026, 0, 1, 0, 0)))).toBe('2026-01-01')
  })

  it('keeps the time and milliseconds in a full timestamp', () => {
    expect(isoTimestamp(new Date(Date.UTC(2026, 8, 11, 23, 30, 15, 250)))).toBe(
      '2026-09-11T23:30:15.250Z',
    )
  })
})

describe('frontmatterValueToString', () => {
  it('renders each value the way the admin raw-YAML view shows it', () => {
    expect(frontmatterValueToString(new Date(Date.UTC(2026, 8, 11, 12)))).toBe('2026-09-11')
    expect(frontmatterValueToString(['linux', 'zsh'])).toBe('linux, zsh')
    expect(frontmatterValueToString(null)).toBe('')
    expect(frontmatterValueToString(undefined)).toBe('')
    expect(frontmatterValueToString(3)).toBe('3')
  })
})

describe('flexibleDate', () => {
  it('anchors a bare YYYY-MM-DD to UTC noon', () => {
    const date = flexibleDate.parse('2026-09-11')

    expect(date.toISOString()).toBe('2026-09-11T12:00:00.000Z')
    // Noon is what keeps the calendar day intact for readers west of UTC: at
    // midnight UTC a reader in Los Angeles would still be on the 10th.
    for (const timeZone of ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Shanghai']) {
      const rendered = new Intl.DateTimeFormat('en-CA', { timeZone }).format(date)
      expect(rendered).toBe('2026-09-11')
    }
  })

  it('accepts the other shapes a frontmatter date arrives in', () => {
    const passthrough = new Date('2026-01-02T03:04:05Z')
    expect(flexibleDate.parse(passthrough)).toBe(passthrough)

    expect(flexibleDate.parse('2026-09-11T10:00:00Z').toISOString()).toBe(
      '2026-09-11T10:00:00.000Z',
    )
    expect(flexibleDate.parse('2026-09-11T10:00:00+02:00').toISOString()).toBe(
      '2026-09-11T08:00:00.000Z',
    )
    expect(flexibleDate.parse(Date.UTC(2026, 8, 11, 10)).toISOString()).toBe(
      '2026-09-11T10:00:00.000Z',
    )
  })

  it('accepts a space-separated date and time, keeping the wall clock', () => {
    // `2026-09-11 10:00` is not valid ISO; without the separator fix it would
    // come back as an Invalid Date and fail validation.
    const date = flexibleDate.parse('2026-09-11 10:00')

    expect(date.getHours()).toBe(10)
    expect(date.getMinutes()).toBe(0)
  })

  it('rejects values it cannot turn into a real date', () => {
    for (const value of ['not a date', '', '   ', new Date('nonsense'), NaN, null, {}]) {
      expect(flexibleDate.safeParse(value).success).toBe(false)
    }
  })
})

describe('post, note and project schemas', () => {
  it('publishes a dated post and uses its date as publishedAt', () => {
    const post = postFrontmatterSchema.parse({ title: 'Hello', date: '2026-09-11' })

    expect(post.status).toBe('published')
    expect(post.publishedAt?.toISOString()).toBe('2026-09-11T12:00:00.000Z')
    // The defaults the loader, the feeds and the renderer rely on.
    expect(post.tags).toEqual([])
    expect(post.toc).toBe(true)
    expect(post.featured).toBe(false)
    expect(post.lang).toBe('en')
  })

  it('holds back an undated post as a draft instead of rejecting it', () => {
    const post = postFrontmatterSchema.parse({ title: 'Hello' })

    expect(post.status).toBe('draft')
    expect(post.publishedAt).toBeUndefined()
  })

  it('rejects a post that claims to be published with no date', () => {
    const result = postFrontmatterSchema.safeParse({ title: 'Hello', status: 'published' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['publishedAt'])
      expect(result.error.issues[0]?.message).toBe('status "published" requires a date')
    }
  })

  it('requires a publishAt timestamp before a document can be scheduled', () => {
    expect(postFrontmatterSchema.safeParse({ title: 'T', status: 'scheduled' }).success).toBe(false)
    expect(noteFrontmatterSchema.safeParse({ status: 'scheduled' }).success).toBe(false)

    const scheduled = postFrontmatterSchema.parse({
      title: 'T',
      status: 'scheduled',
      publishAt: '2026-09-11 09:00',
    })
    expect(scheduled.status).toBe('scheduled')
  })

  it('requires a title from a post and a project but not from a note', () => {
    expect(postFrontmatterSchema.safeParse({ date: '2026-09-11' }).success).toBe(false)
    expect(projectFrontmatterSchema.safeParse({ date: '2026-09-11' }).success).toBe(false)
    // A note takes its title from the body instead.
    expect(noteFrontmatterSchema.safeParse({}).success).toBe(true)
  })

  it('prefers publishedAt over date when both are present', () => {
    const post = postFrontmatterSchema.parse({
      title: 'T',
      date: '2026-01-01',
      publishedAt: '2026-02-02',
    })

    expect(post.publishedAt?.toISOString()).toBe('2026-02-02T12:00:00.000Z')
  })

  it('accepts a comma-separated tag string as a tag list', () => {
    expect(noteFrontmatterSchema.parse({ tags: 'linux, zsh , ' }).tags).toEqual(['linux', 'zsh'])
    expect(noteFrontmatterSchema.parse({ tags: ['linux', ' zsh '] }).tags).toEqual(['linux', 'zsh'])
    expect(noteFrontmatterSchema.parse({ tags: '' }).tags).toEqual([])
  })

  it('blocks a javascript: URL in a field that becomes a link', () => {
    expect(noteFrontmatterSchema.safeParse({ cover: 'javascript:alert(1)' }).success).toBe(false)
    expect(noteFrontmatterSchema.safeParse({ cover: '//evil.example/x' }).success).toBe(false)
    expect(noteFrontmatterSchema.safeParse({ cover: '/images/cover.png' }).success).toBe(true)
  })

  it('validates the fields only a project has', () => {
    const project = projectFrontmatterSchema.parse({
      title: 'P',
      date: '2026-01-01',
      stack: 'ts, go',
    })

    expect(project.projectStatus).toBe('active')
    expect(project.stack).toEqual(['ts', 'go'])

    expect(projectFrontmatterSchema.safeParse({ title: 'P', projectStatus: 'nope' }).success).toBe(false)
    // `repo` ends up in an href, so only http(s) or site-relative values pass.
    expect(projectFrontmatterSchema.safeParse({ title: 'P', repo: 'git@github.com:x/y.git' }).success).toBe(false)
  })
})

describe('normaliseFrontmatterKeys', () => {
  it('turns summary and excerpt into a description', () => {
    expect(normaliseFrontmatterKeys({ summary: 'Short version' }).description).toBe('Short version')
    expect(normaliseFrontmatterKeys({ excerpt: 'Hugo style' }).description).toBe('Hugo style')
  })

  it('never lets an alias overwrite a field the author wrote out', () => {
    const normalised = normaliseFrontmatterKeys({
      description: 'Real',
      summary: 'Old',
      excerpt: 'Older',
    })

    expect(normalised.description).toBe('Real')
  })

  it('maps the publishing aliases that imported files arrive with', () => {
    const normalised = normaliseFrontmatterKeys({
      pubDate: '2020-01-01',
      modified: '2021-02-02',
      github: 'https://github.com/x/y',
      homepage: 'https://x.example',
      tech: ['typescript'],
    })

    expect(normalised).toMatchObject({
      date: '2020-01-01',
      updated: '2021-02-02',
      repo: 'https://github.com/x/y',
      website: 'https://x.example',
      stack: ['typescript'],
    })
  })

  it('collapses a categories list into a single category', () => {
    expect(normaliseFrontmatterKeys({ categories: ['linux', 'zsh'] }).category).toBe('linux')
  })

  it('does not overwrite a canonical key that is already there', () => {
    expect(normaliseFrontmatterKeys({ tech: ['go'], stack: ['ts'] }).stack).toEqual(['ts'])
  })

  it('turns draft: true into a draft status', () => {
    for (const draft of [true, 'true', 1]) {
      expect(normaliseFrontmatterKeys({ draft }).status).toBe('draft')
    }
  })

  it('leaves an explicit status alone even when draft disagrees', () => {
    expect(normaliseFrontmatterKeys({ draft: true, status: 'published' }).status).toBe('published')
  })

  it('does not invent a status for draft: false', () => {
    // An undated file is held back as a draft; forcing `published` here would
    // make an ordinary file fail validation instead of being read.
    expect(normaliseFrontmatterKeys({ draft: false }).status).toBeUndefined()
  })

  it('lifts legacy top-level SEO keys into the seo object', () => {
    const normalised = normaliseFrontmatterKeys({
      canonical: 'https://x.example/a',
      seoTitle: 'Search title',
      noindex: true,
      seo: { ogImage: '/og.png' },
    })

    expect(normalised.seo).toEqual({
      ogImage: '/og.png',
      canonical: 'https://x.example/a',
      title: 'Search title',
      noindex: true,
    })
  })

  it('passes the keys it has never heard of straight through', () => {
    expect(normaliseFrontmatterKeys({ mood: 'calm', rating: 5 })).toMatchObject({
      mood: 'calm',
      rating: 5,
    })
  })
})

describe('splitFrontmatterKeys', () => {
  it('separates the keys the app owns from everything else', () => {
    const { known, extra } = splitFrontmatterKeys({
      title: 'T',
      tags: ['a'],
      mood: 'calm',
      rating: 5,
    })

    expect(known).toEqual({ title: 'T', tags: ['a'] })
    expect(extra).toEqual({ mood: 'calm', rating: 5 })
  })

  it('keeps unknown keys so an admin save cannot delete them', () => {
    const raw = { title: 'T', mood: 'calm', rating: 5 }
    const { known, extra } = splitFrontmatterKeys(raw)

    const written = serializeFrontmatter(known, 'Body.', { extra })

    expect(parseFrontmatter(written).data).toEqual(raw)
  })
})

describe('extractHeadings', () => {
  it('extracts ATX headings with the ids the renderer will emit', () => {
    expect(extractHeadings('# One\n\n## Two\n\n### Three\n')).toEqual([
      { id: 'one', text: 'One', level: 1 },
      { id: 'two', text: 'Two', level: 2 },
      { id: 'three', text: 'Three', level: 3 },
    ])
  })

  it('extracts setext headings from a document that also uses ATX', () => {
    const headings = extractHeadings(
      'Title\n=====\n\nIntro paragraph.\n\n## ATX section\n\nSubtitle\n--------\n\nText.\n',
    )

    expect(headings).toEqual([
      { id: 'title', text: 'Title', level: 1 },
      { id: 'atx-section', text: 'ATX section', level: 2 },
      { id: 'subtitle', text: 'Subtitle', level: 2 },
    ])
  })

  it('does not read --- under a list item, quote or table row as a heading', () => {
    expect(extractHeadings('- item\n---\n')).toEqual([])
    expect(extractHeadings('> quote\n---\n')).toEqual([])
    expect(extractHeadings('| a | b |\n| --- | --- |\n| 1 | 2 |\n')).toEqual([])
    expect(extractHeadings('Name | Value\n--- | ---\n')).toEqual([])
  })

  it('does read --- under ordinary prose as a setext heading, as CommonMark does', () => {
    expect(extractHeadings('Some paragraph\n---\n')).toEqual([
      { id: 'some-paragraph', text: 'Some paragraph', level: 2 },
    ])
  })

  it('gives duplicate headings distinct ids', () => {
    const headings = extractHeadings('# Setup\n\n# Setup\n\n# Setup\n')

    expect(headings.map((heading) => heading.id)).toEqual(['setup', 'setup-1', 'setup-2'])
  })

  it('keeps a generated id from colliding with a heading written by hand', () => {
    const headings = extractHeadings('# Foo\n\n# Foo\n\n# Foo 1\n')

    expect(headings.map((heading) => heading.id)).toEqual(['foo', 'foo-1', 'foo-1-1'])
  })

  it('ignores anything inside a fenced code block', () => {
    expect(extractHeadings('```sh\n# not a heading\necho hi\n```\n\n# Real\n').map((h) => h.text)).toEqual(['Real'])
    expect(extractHeadings('~~~\n# also not a heading\n~~~\n\n# Real\n').map((h) => h.text)).toEqual(['Real'])
    // An unclosed fence hides the rest, exactly as a renderer would show it.
    expect(extractHeadings('```\n# hidden\n')).toEqual([])
  })

  it('strips inline markdown from the label and the anchor', () => {
    expect(extractHeadings('# **Bold** and `code` and [a link](/x)\n')).toEqual([
      { id: 'bold-and-code-and-a-link', text: 'Bold and code and a link', level: 1 },
    ])
    expect(extractHeadings('## Title ##\n')).toEqual([
      { id: 'title', text: 'Title', level: 2 },
    ])
  })
})

describe('buildHeadingTree', () => {
  it('nests headings under the section they belong to', () => {
    // The declared return type is one level deep, because `Heading.children` is
    // a flat list; asserting on grandchildren needs the recursive shape.
    const tree = buildHeadingTree(
      extractHeadings('# A\n\n## B\n\n### C\n\n# D\n'),
    ) as NestedHeading[]

    expect(tree).toHaveLength(2)
    expect(tree[0]?.text).toBe('A')
    expect(tree[0]?.children.map((child) => child.text)).toEqual(['B'])
    expect(tree[0]?.children[0]?.children.map((child) => child.text)).toEqual(['C'])
    expect(tree[1]?.text).toBe('D')
  })

  it('drops a skipped level rather than inventing a parent', () => {
    // An `h4` following an `h2` has no `h3` above it; it becomes a child of the
    // `h2` so the table of contents stays connected.
    const tree = buildHeadingTree(extractHeadings('## A\n\n#### B\n\n### C\n'))

    expect(tree).toHaveLength(1)
    expect(tree[0]?.children.map((child) => child.level)).toEqual([4, 3])
  })

  it('returns an empty tree for a document with no headings', () => {
    expect(buildHeadingTree([])).toEqual([])
  })
})

describe('deriveContent', () => {
  it('uses the declared metadata when the frontmatter has it', () => {
    const derived = deriveContent({
      type: 'post',
      filename: '2026-09-11-ignored.md',
      body: '# Body heading\n\nProse.\n',
      title: 'Declared title',
      slug: 'declared-slug',
      description: 'Declared description',
    })

    expect(derived).toMatchObject({
      title: 'Declared title',
      slug: 'declared-slug',
      description: 'Declared description',
    })
  })

  it('falls back to the first heading, then the first line, then the filename', () => {
    expect(
      deriveContent({ type: 'note', filename: 'note.md', body: '# From the heading\n\nProse.\n' }).title,
    ).toBe('From the heading')
    expect(
      deriveContent({ type: 'note', filename: 'note.md', body: 'From the first line.\n\nMore.\n' }).title,
    ).toBe('From the first line.')
    expect(
      deriveContent({ type: 'note', filename: '2026-09-11-linux-notes.md', body: '' }).title,
    ).toBe('Linux notes')
  })

  it('ignores a heading that is too deep to name the document', () => {
    const derived = deriveContent({
      type: 'note',
      filename: 'note.md',
      body: '#### Deep\n\nProse here.\n',
    })

    expect(derived.title).toBe('Prose here.')
  })

  it('treats a whitespace-only title as missing', () => {
    const derived = deriveContent({
      type: 'note',
      filename: 'note.md',
      body: '# Real title\n\nProse.\n',
      title: '   ',
    })

    expect(derived.title).toBe('Real title')
  })

  it('skips a rule and a quote when looking for a title', () => {
    expect(
      deriveContent({ type: 'note', filename: 'note.md', body: '---\n\nReal first line.\n' }).title,
    ).toBe('Real first line.')
    expect(
      deriveContent({ type: 'note', filename: 'note.md', body: '> quoted\n\nProse.\n' }).title,
    ).toBe('Prose.')
  })

  it('builds the slug from the title and the description from the prose', () => {
    const derived = deriveContent({
      type: 'note',
      filename: 'note.md',
      body: '# Hello World!\n\nA first sentence. A second one.\n',
    })

    expect(derived.slug).toBe('hello-world')
    // The heading is dropped from the snippet rather than repeated as the title.
    expect(derived.description).toBe('A first sentence. A second one.')
  })

  it('caps the plain text it keeps for search', () => {
    const derived = deriveContent({
      type: 'note',
      filename: 'note.md',
      body: 'word '.repeat(20_000),
    })

    expect(derived.plainText.length).toBe(60_000)
  })

  it('counts words and reading time from the prose, not the syntax', () => {
    const derived = deriveContent({
      type: 'note',
      filename: 'note.md',
      body: '# Title\n\n```js\nconst hidden = 1\n```\n\nOne two three four five.\n',
    })

    // Code is not prose, and it must not reach the search index either.
    expect(derived.plainText).not.toContain('const')
    expect(derived.wordCount).toBeGreaterThanOrEqual(5)
    expect(derived.readingTime).toBeGreaterThanOrEqual(1)
  })

  it('reads CJK metadata without mangling it', () => {
    const derived = deriveContent({
      type: 'note',
      filename: '2026-09-11-日本旅行.md',
      body: '# 在 Linux 上部署 Next.js\n\n这是一篇关于部署的文章。\n',
    })

    expect(derived.title).toBe('在 Linux 上部署 Next.js')
    expect(derived.slug).toBe('在-linux-上部署-next-js')
    expect(derived.wordCount).toBeGreaterThan(10)
  })

  it('carries the headings through for the table of contents', () => {
    const derived = deriveContent({ type: 'note', filename: 'note.md', body: '# A\n\n## B\n' })

    expect(derived.headings.map((heading) => heading.id)).toEqual(['a', 'b'])
  })
})

describe('humanizeFilename', () => {
  it('drops a leading date and turns separators into words', () => {
    expect(humanizeFilename('2026-09-11-linux-notes.md')).toBe('Linux notes')
    expect(humanizeFilename('hello_world.md')).toBe('Hello world')
    expect(humanizeFilename('Deploying Next.js.mdx')).toBe('Deploying Next.js')
    expect(humanizeFilename('2026-09-11-日本旅行.md')).toBe('日本旅行')
  })

  it('returns a usable title even when the filename carries none', () => {
    expect(humanizeFilename('.md')).toBe('Untitled')
  })
})

describe('shouldShowToc', () => {
  const heading = (level: number) => ({ id: `h${level}`, text: `H${level}`, level })

  it('only shows a table of contents once there is more than one heading', () => {
    expect(shouldShowToc(true, [])).toBe(false)
    expect(shouldShowToc(true, [heading(1)])).toBe(false)
    expect(shouldShowToc(true, [heading(1), heading(2)])).toBe(true)
    expect(shouldShowToc(true, [heading(1), heading(2), heading(3)])).toBe(true)
  })

  it('honours toc: false however many headings there are', () => {
    expect(shouldShowToc(false, [heading(1), heading(2), heading(3)])).toBe(false)
  })
})

describe('fallbackSlug', () => {
  it('uses the filename, and a unique name when the filename has none', () => {
    expect(fallbackSlug('2026-09-11-linux-notes.md', 'post')).toBe('linux-notes')
    // Two untitled files must not land on the same URL.
    expect(fallbackSlug('.md', 'note')).toMatch(/^note-[a-z0-9]+$/)
  })
})
