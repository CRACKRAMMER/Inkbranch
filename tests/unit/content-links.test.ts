import { describe, expect, it } from 'vitest'
import {
  extractLinks,
  normalizeImageKey,
  parseInternalTarget,
  referencedImageKeys,
  referencedTargets,
  targetKeyToUrl,
  wikiTargetCandidates,
} from '@/lib/content/links'
import { extractHeadings } from '@/lib/content/derive'
import { HeadingSlugger, slugifyHeading } from '@/lib/markdown/slugger'
import { expandLineSpec, parseCodeFenceMeta } from '@/lib/markdown/code-meta'

/**
 * The link scanner is what backlinks, broken-link reports and the knowledge
 * graph are built from, so a miss here is invisible in the UI and wrong in the
 * database. These tests therefore pin the *scanner* behaviour (what is found,
 * what is skipped, which line it came from) as well as the classification
 * helpers that turn a raw href into a resolution key.
 *
 * `line` is the only positional information `ExtractedLink` carries — it is
 * 1-based and is what an editor uses to jump to a reference.
 */

const find = (markdown: string, options?: Parameters<typeof extractLinks>[1]) =>
  extractLinks(markdown, options).links

describe('extractLinks — inline Markdown links', () => {
  it('keeps a link whose text contains a nested pair of brackets', () => {
    const links = find('[a [nested] label](/posts/x)\n')

    expect(links).toEqual([
      {
        kind: 'internal',
        href: '/posts/x',
        targetKey: 'posts/x',
        label: 'a [nested] label',
        line: 1,
      },
    ])
  })

  it('drops a title that follows the href and keeps the href itself', () => {
    const quoted = find('[x](/posts/y "Title")\n')
    const parenthesised = find('[x](/posts/y (Title))\n')

    for (const links of [quoted, parenthesised]) {
      expect(links).toHaveLength(1)
      expect(links[0]?.href).toBe('/posts/y')
      expect(links[0]?.targetKey).toBe('posts/y')
      expect(links[0]?.label).toBe('x')
    }
  })

  it('keeps a balanced pair of parentheses inside the href', () => {
    expect(find('[a](/posts/x_(y))\n')[0]?.href).toBe('/posts/x_(y)')
  })

  it('unwraps an href written between angle brackets', () => {
    expect(find('[a](</posts/x>)\n')[0]?.href).toBe('/posts/x')
  })

  it('ignores a bracket that is escaped, because it opens no link', () => {
    // The renderer turns `\[a](/posts/x)` into the literal text, so a link
    // recorded here would be a backlink no reader can see or click.
    expect(find('\\[a](/posts/x)\n')).toEqual([])
  })

  it('still finds the link when only the image marker is escaped', () => {
    // `\!` is a literal `!`, so what follows is an ordinary link — which is
    // exactly the markup the renderer produces.
    expect(find('\\![a](/posts/x)\n')[0]?.targetKey).toBe('posts/x')
  })

  it('still finds a link after an escaped backslash', () => {
    // `\\` is one literal backslash, so the bracket that follows is a real one.
    expect(find('\\\\[a](/posts/x)\n')[0]?.targetKey).toBe('posts/x')
  })

  it('reports every reference on a line, in source order', () => {
    const links = find('[a](/posts/x) and [b](/posts/y) and ![c](/uploads/c.png)\n')

    expect(links.map((link) => [link.kind, link.targetKey])).toEqual([
      ['internal', 'posts/x'],
      ['internal', 'posts/y'],
      ['image', 'c.png'],
    ])
  })

  it('reports an empty label as null rather than an empty string', () => {
    expect(find('[](/posts/x)\n')[0]?.label).toBeNull()
  })
})

describe('extractLinks — code spans and fenced blocks', () => {
  it('does not scan a link inside an inline code span', () => {
    const links = find('`[not a link](/posts/x)` and [yes](/posts/y)\n')

    expect(links).toHaveLength(1)
    expect(links[0]?.targetKey).toBe('posts/y')
    // Blanking the span must not shift the scan: the surviving link is still
    // reported with its own label, not with the span's text.
    expect(links[0]?.label).toBe('yes')
  })

  it('does not scan a wiki link or an img tag inside an inline code span', () => {
    expect(find('`[[posts/x]]` and `<img src="/uploads/x.png">`\n')).toEqual([])
  })

  it('does not scan a link, a wiki link or an img tag inside a fenced block', () => {
    const markdown = [
      '```md',
      '[in fence](/posts/a)',
      '[[posts/b]]',
      '<img src="/uploads/b.png">',
      '```',
      '',
    ].join('\n')

    expect(find(markdown)).toEqual([])
  })

  it('treats a tilde fence as a fence too', () => {
    expect(find('~~~\n[a](/posts/x)\n~~~\n')).toEqual([])
  })

  it('lets an unclosed fence swallow the rest of the document', () => {
    expect(find('```\n[a](/posts/x)\n')).toEqual([])
  })
})

describe('extractLinks — line reporting', () => {
  it('reports the 1-based line of each reference and skips fenced lines', () => {
    const markdown = [
      '# Title', // 1
      '', // 2
      'Intro [first](/posts/first).', // 3
      '', // 4
      '```ts', // 5
      '[ignored](/posts/ignored)', // 6
      '```', // 7
      '', // 8
      'Outro [second](/posts/second).', // 9
    ].join('\n')

    expect(find(markdown).map((link) => [link.targetKey, link.line])).toEqual([
      ['posts/first', 3],
      ['posts/second', 9],
    ])
  })

  it('reports lines correctly for CRLF input', () => {
    expect(find('one\r\n[link](/posts/z)\r\n')[0]?.line).toBe(2)
  })

  it('finds nothing in an empty document', () => {
    expect(extractLinks('')).toEqual({ links: [], externalCount: 0 })
  })
})

describe('extractLinks — classification of non-document references', () => {
  it('treats a same-origin absolute URL as the internal target it names', () => {
    const links = find('[a](https://example.com/posts/x)\n', {
      siteUrl: 'https://example.com',
    })

    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ kind: 'internal', targetKey: 'posts/x' })
    // The href stays exactly as written; only the key is normalised.
    expect(links[0]?.href).toBe('/posts/x')
  })

  it('treats a same-origin URL as external when no site URL is configured', () => {
    const result = extractLinks('[a](https://example.com/posts/x)\n')

    expect(result.links).toEqual([])
    expect(result.externalCount).toBe(1)
  })

  it('counts an off-site URL as external without inventing a target', () => {
    const result = extractLinks('[a](https://other.example/x)\n', {
      siteUrl: 'https://example.com',
    })

    expect(result.links).toEqual([])
    expect(result.externalCount).toBe(1)
  })

  it('counts a mailto: link as external, since it leaves the site', () => {
    const result = extractLinks('[a](mailto:someone@example.com)\n')

    expect(result.links).toEqual([])
    expect(result.externalCount).toBe(1)
  })

  it('counts a protocol-relative URL as external', () => {
    const result = extractLinks('[a](//cdn.example/x)\n')

    expect(result.links).toEqual([])
    expect(result.externalCount).toBe(1)
  })

  it('records a bare fragment as an anchor keyed by the fragment', () => {
    expect(find('[a](#heading-name)\n')).toEqual([
      {
        kind: 'anchor',
        href: '#heading-name',
        targetKey: 'heading-name',
        label: 'a',
        line: 1,
      },
    ])
  })

  it('ignores a bare #, which points at the page top', () => {
    expect(find('[a](#)\n')).toEqual([])
  })

  it('records a site-relative non-document path as an anchor keyed by the path', () => {
    expect(find('[a](/tags/linux)\n')[0]).toMatchObject({
      kind: 'anchor',
      targetKey: '/tags/linux',
    })
  })

  it('keeps the document key of an internal link and drops its fragment', () => {
    expect(find('[a](/posts/y#section)\n')[0]).toMatchObject({
      kind: 'internal',
      targetKey: 'posts/y',
    })
  })

  it('classifies an image written as a Markdown link by its extension', () => {
    expect(find('[a](/uploads/p.png)\n')[0]).toMatchObject({
      kind: 'image',
      targetKey: 'p.png',
    })
  })

  it('does not mistake a lookalike directory for the upload prefix', () => {
    // `/uploadsx/` shares a prefix with `/uploads/` but is not inside it.
    expect(find('[a](/uploadsx/p.png)\n')[0]?.kind).toBe('anchor')
  })
})

describe('extractLinks — HTML images', () => {
  it('reads an img tag with a double-quoted src and alt', () => {
    expect(find('<img src="/uploads/a.png" alt="Diagram" width="40">\n')).toEqual([
      {
        kind: 'image',
        href: '/uploads/a.png',
        targetKey: 'a.png',
        label: 'Diagram',
        line: 1,
      },
    ])
  })

  it('reads single-quoted attributes and an unquoted src', () => {
    const single = find("<img src='/uploads/a.png' alt='A'>\n")
    const unquoted = find('<img src=/uploads/a.png>\n')

    expect(single[0]).toMatchObject({ targetKey: 'a.png', label: 'A' })
    // No alt attribute: the label is absent, not an empty string.
    expect(unquoted[0]).toMatchObject({ targetKey: 'a.png', label: null })
  })

  it('is case-insensitive about the tag and its attributes', () => {
    expect(find('<IMG SRC="/uploads/x.png" ALT="X">\n')[0]?.targetKey).toBe('x.png')
  })

  it('skips an img tag with no src, or an empty one', () => {
    expect(find('<img alt="orphan">\n')).toEqual([])
    expect(find('<img src="">\n')).toEqual([])
  })

  it('counts an external img as external and records nothing', () => {
    const result = extractLinks('<img src="https://cdn.example/a.png">\n')

    expect(result.links).toEqual([])
    expect(result.externalCount).toBe(1)
  })
})

describe('extractLinks — wiki links', () => {
  it('reads [[type/slug]] with its type already spelled out', () => {
    expect(find('[[posts/x]]\n')).toEqual([
      {
        kind: 'wiki',
        href: 'posts/x',
        targetKey: 'posts/x',
        label: null,
        line: 1,
      },
    ])
  })

  it('reads the label half of [[type/slug|Label]]', () => {
    expect(find('[[posts/y|See also]]\n')[0]).toMatchObject({
      targetKey: 'posts/y',
      label: 'See also',
    })
  })

  it('keeps a bare slug, which is the Obsidian spelling', () => {
    // A bare slug cannot be narrowed to a type here, because this module never
    // sees the content index. It is reported unresolved rather than dropped:
    // the link renders for the reader either way, so dropping it would hide
    // the missing backlink from the only person who could fix it.
    expect(find('[[bare-slug]]\n')[0]).toMatchObject({
      kind: 'wiki',
      targetKey: 'bare-slug',
    })
  })

  it('finds wiki links next to Markdown links without confusing the two', () => {
    expect(
      find('[[posts/x|Wiki]] [md](/posts/y)\n').map((link) => [link.kind, link.targetKey]),
    ).toEqual([
      ['internal', 'posts/y'],
      ['wiki', 'posts/x'],
    ])
  })

  it('reports each wiki link on its own line with its own number', () => {
    expect(
      find('[[posts/a]]\n\n[[posts/b]]\n').map((link) => link.line),
    ).toEqual([1, 3])
  })

  it('narrows a wiki link to an anchor when it only names a heading', () => {
    expect(find('[[#section]]\n')[0]).toMatchObject({ kind: 'anchor', targetKey: 'section' })
    expect(find('[[posts/x#section]]\n')[0]).toMatchObject({
      kind: 'wiki',
      targetKey: 'posts/x',
    })
  })
})

describe('extractLinks — code spans and queries', () => {
  it('ignores a link inside a matched code span', () => {
    expect(find('`[x](/posts/y)` and [real](/posts/z)\n').map((l) => l.targetKey)).toEqual([
      'posts/z',
    ])
  })

  it('still finds a link after an unpaired backtick', () => {
    // CommonMark treats an unpaired backtick as punctuation, not as an opening
    // fence, so the link after it is real — and blanking to the end of the line
    // would drop it from the backlink index with nothing to show why.
    expect(find('a ` b [real](/posts/z)\n').map((l) => l.targetKey)).toEqual(['posts/z'])
  })

  it('drops the query string from an internal link', () => {
    // `/posts/y?utm_source=x` is a link to `y`. Keeping the query produces a
    // slug that matches no document and reads as a typo the author never made.
    expect(parseInternalTarget('/posts/y?utm_source=x')).toEqual({
      type: 'post',
      slug: 'y',
      hash: null,
    })
    expect(find('[x](/posts/y?utm_source=x#h)\n')[0]?.targetKey).toBe('posts/y')
  })
})

describe('wikiTargetCandidates', () => {
  it('offers every directory for a bare slug, and one key for a typed target', () => {
    expect(wikiTargetCandidates('hello')).toEqual([
      'posts/hello',
      'notes/hello',
      'projects/hello',
    ])
    expect(wikiTargetCandidates('notes/hello')).toEqual(['notes/hello'])
  })

  it('ignores a leading slash and case, both of which Obsidian tolerates', () => {
    expect(wikiTargetCandidates('/Hello')).toEqual([
      'posts/hello',
      'notes/hello',
      'projects/hello',
    ])
  })

  it('offers nothing for an empty target', () => {
    expect(wikiTargetCandidates('   ')).toEqual([])
  })
})

describe('extractLinks — counting and aggregation', () => {
  it('counts every external reference of any kind', () => {
    const markdown = [
      '[a](https://x.example/1)',
      '![b](https://x.example/2.png)',
      '<img src="https://x.example/3.png">',
      '',
    ].join('\n')

    expect(extractLinks(markdown).externalCount).toBe(3)
  })

  it('lists each referenced target once, keeping the first occurrence', () => {
    const links = find('[b](/posts/b) [a](/posts/b "Again") [c](/posts/c)\n')

    expect(referencedTargets(links).map((link) => link.targetKey)).toEqual([
      'posts/b',
      'posts/c',
    ])
    expect(referencedTargets(links)[0]?.label).toBe('b')
  })

  it('lists each referenced image once and ignores everything else', () => {
    const links = find(
      '![i](/uploads/i.png) ![again](/uploads/i.png) [doc](/posts/d) <img src="/uploads/j.png">\n',
    )

    expect(referencedImageKeys(links)).toEqual(['i.png', 'j.png'])
  })

  it('reports no targets when a document only links out of the site', () => {
    const links = find('[a](https://x.example/1) [b](/tags/linux) [c](#top)\n')

    expect(referencedTargets(links)).toEqual([])
    expect(referencedImageKeys(links)).toEqual([])
  })
})

describe('parseInternalTarget', () => {
  it('maps each type directory to its content type', () => {
    expect(parseInternalTarget('/posts/x')).toEqual({
      type: 'post',
      slug: 'x',
      hash: null,
    })
    expect(parseInternalTarget('/notes/x')).toMatchObject({ type: 'note' })
    expect(parseInternalTarget('/projects/x')).toMatchObject({ type: 'project' })
  })

  it('accepts the path with or without a leading slash, and with a fragment', () => {
    expect(parseInternalTarget('posts/x')).toMatchObject({ slug: 'x' })
    expect(parseInternalTarget('/posts/x#usage')).toMatchObject({
      slug: 'x',
      hash: 'usage',
    })
  })

  it('decodes a percent-encoded slug', () => {
    expect(parseInternalTarget('/posts/a%20b')?.slug).toBe('a b')
  })

  it('falls back to the raw text when percent-encoding is malformed', () => {
    expect(parseInternalTarget('/posts/%E0%A4%A')?.slug).toBe('%E0%A4%A')
  })

  it('returns null for anything that is not a document path', () => {
    expect(parseInternalTarget('/posts')).toBeNull()
    expect(parseInternalTarget('/notatype/x')).toBeNull()
    expect(parseInternalTarget('')).toBeNull()
  })
})

describe('normalizeImageKey', () => {
  it('strips the configured upload prefix', () => {
    expect(normalizeImageKey('/uploads/a.png', '/uploads')).toBe('a.png')
    expect(normalizeImageKey('/media/a.png', '/media')).toBe('a.png')
  })

  it('strips a bare uploads/ path, which is how Obsidian-style notes write it', () => {
    expect(normalizeImageKey('uploads/a.png', '/uploads')).toBe('a.png')
  })

  it('ignores a query string and a fragment', () => {
    expect(normalizeImageKey('/uploads/a.png?w=200#x', '/uploads')).toBe('a.png')
  })

  it('returns null for an external image, which needs no local key', () => {
    expect(normalizeImageKey('https://cdn.example/a.png', '/uploads')).toBeNull()
  })

  it('returns null for a path outside the upload root or with no path at all', () => {
    expect(normalizeImageKey('/uploadsx/a.png', '/uploads')).toBeNull()
    expect(normalizeImageKey('#fragment', '/uploads')).toBeNull()
    expect(normalizeImageKey('', '/uploads')).toBeNull()
  })
})

describe('targetKeyToUrl', () => {
  it('maps the keys the scanner produces back to their routes', () => {
    // Keys are built as `${type}s/${slug}`, so the prefix is the directory.
    expect(targetKeyToUrl('posts/hello')).toBe('/posts/hello')
    expect(targetKeyToUrl('notes/hello')).toBe('/notes/hello')
    expect(targetKeyToUrl('projects/hello')).toBe('/projects/hello')
  })

  it('percent-encodes the slug on the way back to a URL', () => {
    expect(targetKeyToUrl('posts/a b')).toBe('/posts/a%20b')
  })

  it('returns null for a prefix that is not a content directory', () => {
    expect(targetKeyToUrl('tags/linux')).toBeNull()
    expect(targetKeyToUrl('junk/hello')).toBeNull()
  })

  it('returns null when the key has no slug', () => {
    expect(targetKeyToUrl('posts')).toBeNull()
    expect(targetKeyToUrl('/hello')).toBeNull()
    expect(targetKeyToUrl('')).toBeNull()
  })
})

describe('HeadingSlugger — GitHub algorithm', () => {
  it('lowercases and turns spaces into hyphens', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world')
    expect(slugifyHeading('Mixed CASE Heading')).toBe('mixed-case-heading')
  })

  it('removes punctuation and symbols', () => {
    expect(slugifyHeading('Hello, World!')).toBe('hello-world')
    expect(slugifyHeading("It’s \"quoted\"")).toBe('its-quoted')
    expect(slugifyHeading('foo — bar')).toBe('foo--bar')
  })

  it('keeps letters, so accented and non-Latin headings survive', () => {
    // Accents and CJK are letters, not punctuation: GitHub keeps them, and the
    // slug is only ever compared with another slug from the same function.
    expect(slugifyHeading('Café Déjà Vu')).toBe('café-déjà-vu')
    expect(slugifyHeading('中文 标题')).toBe('中文-标题')
    expect(slugifyHeading('Привет Мир')).toBe('привет-мир')
  })

  it('keeps underscores, hyphens and digits', () => {
    expect(slugifyHeading('a_b-c2')).toBe('a_b-c2')
  })

  it('removes an explicit # from the heading text', () => {
    expect(slugifyHeading('C# Guide')).toBe('c-guide')
    expect(slugifyHeading('#hashtag')).toBe('hashtag')
    expect(slugifyHeading('Title #')).toBe('title-')
  })
})

describe('HeadingSlugger — uniqueness', () => {
  it('suffixes the second and third heading with the same text', () => {
    const slugger = new HeadingSlugger()

    expect(['x', 'x', 'x'].map((text) => slugger.slug(text))).toEqual([
      'x',
      'x-1',
      'x-2',
    ])
  })

  it('does not hand out a suffix that a literal heading already claimed', () => {
    const slugger = new HeadingSlugger()

    expect(['Foo', 'Foo', 'Foo 1', 'Foo'].map((text) => slugger.slug(text))).toEqual([
      'foo',
      'foo-1',
      'foo-1-1',
      'foo-2',
    ])
  })

  it('suffixes a heading that slugifies to nothing at all', () => {
    const slugger = new HeadingSlugger()

    expect(['!!!', '***'].map((text) => slugger.slug(text))).toEqual(['', '-1'])
  })

  it('keeps each document independent, and reset() clears the state', () => {
    const first = new HeadingSlugger()
    const second = new HeadingSlugger()

    expect(first.slug('Same Text')).toBe('same-text')
    expect(second.slug('Same Text')).toBe('same-text')

    first.slug('Same Text')
    first.reset()
    expect(first.slug('Same Text')).toBe('same-text')
  })

  it('is stable: the same text always yields the same slug', () => {
    expect(slugifyHeading('Stable Heading')).toBe(slugifyHeading('Stable Heading'))
  })
})

describe('HeadingSlugger — agreement with the table of contents', () => {
  it('produces the ids derive.ts stores for the TOC', () => {
    const body = [
      '# Getting Started',
      '',
      '## Install, then run',
      '',
      '## Install, then run',
      '',
      '## 中文 章节',
      '',
    ].join('\n')

    const headings = extractHeadings(body)
    const slugger = new HeadingSlugger()

    // The TOC anchors and the rendered heading ids must come from one function,
    // so derive.ts has to agree with the slugger text for text — including the
    // duplicate suffix — or every TOC link after the first duplicate 404s.
    expect(headings.map((heading) => heading.id)).toEqual(
      headings.map((heading) => slugger.slug(heading.text)),
    )
    expect(headings.map((heading) => heading.id)).toEqual([
      'getting-started',
      'install-then-run',
      'install-then-run-1',
      '中文-章节',
    ])
  })
})

describe('parseCodeFenceMeta — title and badge', () => {
  it('reads a quoted title in either quote style, and the bare form', () => {
    expect(parseCodeFenceMeta('title="src/a.ts"', 'ts').title).toBe('src/a.ts')
    expect(parseCodeFenceMeta("title='src/a.ts'", 'ts').title).toBe('src/a.ts')
    expect(parseCodeFenceMeta('title=src/a.ts', 'ts').title).toBe('src/a.ts')
  })

  it('accepts filename= and file= as aliases for title=', () => {
    expect(parseCodeFenceMeta('filename="a.ts"', 'ts').title).toBe('a.ts')
    expect(parseCodeFenceMeta('file=a.ts', 'ts').title).toBe('a.ts')
  })

  it('reads a badge, quoted or as a bare word', () => {
    expect(parseCodeFenceMeta('badge=ts', 'ts').badge).toBe('ts')
    expect(parseCodeFenceMeta('badge="shell"', 'bash').badge).toBe('shell')
    expect(parseCodeFenceMeta('label=warning', 'txt').badge).toBe('warning')
  })

  it('leaves title and badge null when the fence declares neither', () => {
    const meta = parseCodeFenceMeta('', 'ts')

    expect(meta.title).toBeNull()
    expect(meta.badge).toBeNull()
  })
})

describe('parseCodeFenceMeta — line numbers', () => {
  it('reads {1,3-5} into the highlighted display lines', () => {
    expect(parseCodeFenceMeta('{1,3-5}', 'ts').highlightLines).toEqual([1, 3, 4, 5])
    expect(parseCodeFenceMeta('title="a.ts" {1,3-5}', 'ts').highlightLines).toEqual([
      1, 3, 4, 5,
    ])
  })

  it('turns line numbers on with showLineNumbers and off again with =false', () => {
    expect(parseCodeFenceMeta('showLineNumbers', 'ts').showLineNumbers).toBe(true)
    expect(parseCodeFenceMeta('lineNumbers', 'ts').showLineNumbers).toBe(true)
    expect(parseCodeFenceMeta('showLineNumbers=false', 'ts').showLineNumbers).toBe(
      false,
    )
    expect(parseCodeFenceMeta('', 'ts').showLineNumbers).toBe(false)
  })

  it('reads start= as the first displayed line number', () => {
    expect(parseCodeFenceMeta('start=5', 'ts').startLine).toBe(5)
    expect(parseCodeFenceMeta('start=007', 'ts').startLine).toBe(7)
  })

  it('ignores a start value that is not a positive integer', () => {
    expect(parseCodeFenceMeta('start=0', 'ts').startLine).toBe(1)
    expect(parseCodeFenceMeta('start=-5', 'ts').startLine).toBe(1)
  })

  it('does not read the `startLine=` spelling, which is not the documented syntax', () => {
    // The field is called `startLine`, but the fence syntax is `start=`.
    expect(parseCodeFenceMeta('startLine=5', 'ts').startLine).toBe(1)
  })

  it('shifts plain line numbers by start= but leaves ranges absolute', () => {
    // The two documented readings: `start=10 {3,4}` highlights the third and
    // fourth *displayed* lines, while `start=50 {55-57}` names real lines.
    expect(parseCodeFenceMeta('start=10 {3,4}', 'ts').highlightLines).toEqual([12, 13])
    expect(parseCodeFenceMeta('start=50 {55-57}', 'ts').highlightLines).toEqual([
      55, 56, 57,
    ])
  })
})

describe('parseCodeFenceMeta — word highlights', () => {
  it('collects the words between slashes', () => {
    expect(parseCodeFenceMeta('/retry/', 'ts').highlightWords).toEqual(['retry'])
    expect(parseCodeFenceMeta('/two words/', 'ts').highlightWords).toEqual(['two words'])
    expect(parseCodeFenceMeta('/a/ /b c/', 'ts').highlightWords).toEqual(['a', 'b c'])
  })

  it('reads the word spec that follows a title, rather than pairing its slashes', () => {
    // A title such as `src/index.ts` holds a slash of its own; only a token
    // bracketed by slashes on both sides is a word spec.
    const meta = parseCodeFenceMeta('title="src/index.ts" {3,7-9} /retry/', 'ts')

    expect(meta.highlightWords).toEqual(['retry'])
    expect(meta.title).toBe('src/index.ts')
    expect(meta.highlightLines).toEqual([3, 7, 8, 9])
  })

  it('does not mistake the slashes of a path for a word spec', () => {
    expect(parseCodeFenceMeta('title="src/lib/content/links.ts"', 'ts').highlightWords)
      .toEqual([])
  })

  it('ignores a runaway pair of slashes that swallows a whole line of prose', () => {
    const long = `/${'x'.repeat(81)}/`

    expect(parseCodeFenceMeta(long, 'ts').highlightWords).toEqual([])
  })

  it('does not read the `word=` spelling, which is not the documented syntax', () => {
    expect(parseCodeFenceMeta('word=highlight', 'ts').highlightWords).toEqual([])
  })

  it('does not carry words from one fence into the next', () => {
    // `DEFAULTS` is module state: a shared array here would make every later
    // fence highlight the first fence's words.
    parseCodeFenceMeta('/leaked/', 'ts')

    expect(parseCodeFenceMeta('', 'ts').highlightWords).toEqual([])
    expect(parseCodeFenceMeta(undefined, 'ts').highlightWords).toEqual([])
  })
})

describe('parseCodeFenceMeta — language flags', () => {
  it('marks diff and patch blocks, and numbers their lines', () => {
    const diff = parseCodeFenceMeta('', 'diff')
    const patch = parseCodeFenceMeta('', 'patch')

    expect(diff.isDiff).toBe(true)
    expect(patch.isDiff).toBe(true)
    // A diff without line numbers cannot be talked about in review, and a bare
    // ```diff fence is the common spelling — it has no meta string to read.
    expect(diff.showLineNumbers).toBe(true)
    expect(patch.showLineNumbers).toBe(true)
    expect(parseCodeFenceMeta(undefined, 'diff').showLineNumbers).toBe(true)
  })

  it('still lets an explicit showLineNumbers=false opt a diff back out', () => {
    expect(parseCodeFenceMeta('showLineNumbers=false', 'diff').showLineNumbers).toBe(
      false,
    )
  })

  it('marks terminal-style blocks from each of their aliases', () => {
    for (const language of ['terminal', 'console', 'shellsession']) {
      expect(parseCodeFenceMeta('', language).isTerminal).toBe(true)
    }
    expect(parseCodeFenceMeta('', 'bash').isTerminal).toBe(false)
  })

  it('marks a block as a session when the meta string says terminal', () => {
    // The spelling the module's own documentation promises: a transcript is
    // written in the language it was typed in, so the fence says both.
    expect(parseCodeFenceMeta('terminal', 'bash').isTerminal).toBe(true)
    expect(parseCodeFenceMeta('terminal showLineNumbers', 'sh').isTerminal).toBe(true)
    expect(parseCodeFenceMeta('title="deploy.sh" terminal', 'bash').isTerminal).toBe(true)
  })

  it('does not read the word terminal out of a title', () => {
    // `title` is a filename, and a file called `terminal` is not a session.
    expect(parseCodeFenceMeta('title="terminal"', 'bash').isTerminal).toBe(false)
    expect(parseCodeFenceMeta('title=terminal', 'bash').isTerminal).toBe(false)
    expect(parseCodeFenceMeta('badge="terminals"', 'ts').isTerminal).toBe(false)
  })

  it('marks a mermaid block whatever the case of the label', () => {
    expect(parseCodeFenceMeta('', 'mermaid').isMermaid).toBe(true)
    expect(parseCodeFenceMeta('', 'MERMAID').isMermaid).toBe(true)
    expect(parseCodeFenceMeta('', 'ts').isMermaid).toBe(false)
  })

  it('falls back to the defaults for an unknown or missing language', () => {
    const meta = parseCodeFenceMeta(undefined, undefined)

    expect(meta).toEqual({
      title: null,
      badge: null,
      showLineNumbers: false,
      highlightLines: [],
      highlightWords: [],
      startLine: 1,
      isDiff: false,
      isTerminal: false,
      isMermaid: false,
    })
  })

  it('reads a title, a line spec, a word spec and start= from one meta string', () => {
    const meta = parseCodeFenceMeta('title="src/a.ts" {1,3-5} /retry/ start=1', 'ts')

    expect(meta.title).toBe('src/a.ts')
    expect(meta.highlightLines).toEqual([1, 3, 4, 5])
    expect(meta.highlightWords).toEqual(['retry'])
    expect(meta.startLine).toBe(1)
  })
})

describe('expandLineSpec', () => {
  it('expands a mixed list of single lines and ranges, sorted', () => {
    expect(expandLineSpec('1,3-5,9')).toEqual([1, 3, 4, 5, 9])
  })

  it('tolerates spaces around the separators', () => {
    expect(expandLineSpec(' 1 , 3 - 5 ')).toEqual([1, 3, 4, 5])
  })

  it('lists a repeated line once', () => {
    expect(expandLineSpec('5,5,3')).toEqual([3, 5])
  })

  it('skips empty parts instead of failing on them', () => {
    expect(expandLineSpec('')).toEqual([])
    expect(expandLineSpec('3,')).toEqual([3])
    expect(expandLineSpec(',,,')).toEqual([])
  })

  it('reads a reversed range as the span its two ends describe', () => {
    // `{5-1}` is a typo, not a request for lines 1 through 5 *minus* lines 1-4.
    expect(expandLineSpec('5-1')).toEqual([1, 2, 3, 4, 5])
  })

  it('returns nothing for a range whose ends are not numbers', () => {
    expect(expandLineSpec('a-b')).toEqual([])
    expect(expandLineSpec('{a-b}')).toEqual([])
  })

  it('drops a range wider than its bound rather than building a huge array', () => {
    // The bound is what keeps a `{1-100000}` typo from allocating the array.
    expect(expandLineSpec('1-100000')).toEqual([])
    expect(expandLineSpec('1-2001')).toHaveLength(2001)
  })

  it('never returns NaN, however malformed the spec is', () => {
    const specs = ['5-1', 'a-b', '1-100000', '1-', '-', '3-1-2', '1..5', '{}']

    for (const spec of specs) {
      expect(expandLineSpec(spec).every((line) => Number.isFinite(line))).toBe(true)
    }
  })

  it('shifts single numbers by startLine and leaves ranges absolute', () => {
    expect(expandLineSpec('1,2', 50)).toEqual([50, 51])
    expect(expandLineSpec('55-57', 50)).toEqual([55, 56, 57])
  })
})
