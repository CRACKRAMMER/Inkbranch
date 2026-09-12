import { describe, expect, it } from 'vitest'

import { parseFrontmatter, serializeFrontmatter } from '@/lib/content/frontmatter'
import {
  FRONTMATTER_ALIASES,
  LEGACY_SEO_KEYS,
  normaliseFrontmatterKeys,
  splitFrontmatterKeys,
} from '@/lib/content/schema'
import {
  formValuesFromFrontmatter,
  frontmatterFromForm,
  preservedKeys,
  type ContentFormValues,
} from '@/lib/admin/frontmatter-form'

/**
 * The panel is the one place a save can quietly rewrite a file the author
 * wrote, so these tests run the whole path a save takes rather than any one
 * function in it: the file's bytes in, the file's bytes out, and a check on
 * what changed between them.
 *
 * The path is the one `saveContentAction` takes —
 * `parseFrontmatter` → `normaliseFrontmatterKeys` → `splitFrontmatterKeys` →
 * `formValuesFromFrontmatter` (what the editor shows) → `preservedKeys` →
 * `frontmatterFromForm` (what the form hands the writer) →
 * `serializeFrontmatter(data, body, { extra })`, plus the one line the action
 * itself adds (`content.ts`, the `updated` stamp). The lock and the checksum
 * guard are the only parts left out, and they decide whether a write happens
 * rather than which keys it holds.
 */
function save(
  lines: string[],
  type: 'post' | 'note' | 'project' = 'post',
): { data: Record<string, unknown>; values: ContentFormValues } {
  const source = ['---', ...lines, '---', 'Body.', ''].join('\n')
  const parsed = parseFrontmatter(source)
  const normalised = normaliseFrontmatterKeys(parsed.data)
  const { known, extra } = splitFrontmatterKeys(normalised)

  const values = formValuesFromFrontmatter(normalised, { status: 'draft' })
  const data = frontmatterFromForm(values, preservedKeys(known), {
    dateKey: 'date',
    type,
  })

  // `saveContentAction` restamps a file that already carries `updated`, so that
  // the index does not fall back to the file's mtime. Mirrored here because one
  // alias — `modified` — lands on that key.
  if (normalised.updated !== undefined) {
    data.updated = new Date().toISOString().slice(0, 10)
  }

  return {
    data: parseFrontmatter(serializeFrontmatter(data, parsed.content, { extra })).data,
    values,
  }
}

/**
 * Aliases whose canonical key belongs to a project. The table is
 * type-agnostic; the panel is not, so these are the five that need the type
 * that actually has somewhere to put the value.
 */
const PROJECT_ALIASES = new Set([
  'project_status',
  'github',
  'homepage',
  'tech',
  'techStack',
])

describe('a save leaves one spelling of a fact', () => {
  it.each(Object.entries(FRONTMATTER_ALIASES))(
    'rewrites %s as %s rather than keeping both',
    (alias, canonical) => {
      // Every alias the normaliser folds has to be retired by the save, or the
      // file ends up carrying two spellings of one fact — the state
      // `FORM_OWNED_KEYS` exists to prevent. This is the half that made it
      // possible for `ogImage` to be the one spelling that escaped: the panel
      // owns a key only if `KNOWN_FRONTMATTER_KEYS` put it in the half that
      // `preservedKeys` filters, and a spelling in `extra` is written back
      // verbatim instead.
      const type = PROJECT_ALIASES.has(alias) ? 'project' : 'post'
      const { data } = save(
        ['title: A thing', `${alias}: the alias`, 'date: 2026-01-01'],
        type,
      )

      expect(data).not.toHaveProperty(alias)
      expect(data).toHaveProperty(canonical)
    },
  )

  it('drops a project spelling that lands on a type with no such key', () => {
    // `tech` folds onto `stack`, and a post has no stack — the post schema has
    // no such field, so the value was never readable there. What goes is a line
    // that said nothing to anything; the alias list is what makes that a
    // decision rather than an accident.
    const { data } = save(['title: A thing', 'date: 2026-01-01', 'tech: TypeScript'])

    expect(data).not.toHaveProperty('tech')
    expect(data).not.toHaveProperty('stack')
  })

  it.each(LEGACY_SEO_KEYS)('rewrites a top-level %s into the seo block', (spelling) => {
    const values: Record<string, string | boolean> = {
      canonical: 'https://x.example/a',
      ogImage: '/og/legacy.png',
      seoTitle: 'Search title',
      seoDescription: 'Search description',
      noindex: true,
    }

    const { data } = save(['title: A thing', 'date: 2026-01-01', `${spelling}: ${values[spelling]}`])

    expect(data).not.toHaveProperty(spelling)
    expect(data.seo).toBeTruthy()
    expect(Object.keys(data.seo as Record<string, unknown>)).toHaveLength(1)
  })

  it('keeps a key it has never heard of', () => {
    // The other half of the rule, and the reason the alias list is explicit
    // rather than "anything the schema does not recognise": a key nothing
    // understands rides through the save untouched.
    const { data, values } = save(['title: A thing', 'date: 2026-01-01', 'mood: calm'])

    expect(data.mood).toBe('calm')
    expect(values.title).toBe('A thing')
  })

  it('keeps a key the app knows but the panel does not expose', () => {
    // `lang` is in the schema and not in `FORM_OWNED_KEYS`, so the panel has no
    // field for it and must not invent one — it travels in the half
    // `preservedKeys` keeps, which is also what the editor lists read-only.
    const parsed = parseFrontmatter('---\ntitle: T\nlang: zh\n---\n')
    const normalised = normaliseFrontmatterKeys(parsed.data)
    const known = splitFrontmatterKeys(normalised).known

    expect(preservedKeys(known)).toEqual({ lang: 'zh' })

    const data = frontmatterFromForm(
      formValuesFromFrontmatter(normalised, { status: 'draft' }),
      preservedKeys(known),
      { dateKey: 'date', type: 'post' },
    )
    expect(data.lang).toBe('zh')
  })
})

describe('the panel writes only what the author set', () => {
  it('removes an optional key rather than emptying it', () => {
    const parsed = parseFrontmatter('---\ntitle: T\ndate: 2026-01-01\nseries: Old\n---\n')
    const normalised = normaliseFrontmatterKeys(parsed.data)
    const values = formValuesFromFrontmatter(normalised, { status: 'draft' })

    const data = frontmatterFromForm(
      { ...values, title: 'T', series: '' },
      preservedKeys(splitFrontmatterKeys(normalised).known),
      { dateKey: 'date', type: 'post' },
    )

    expect(data).not.toHaveProperty('series')
  })

  it('keeps the date spelling the file already used', () => {
    // A file written as `publishedAt:` must not come back as `date:`: the two
    // are the same fact in two spellings, and the panel is not the place to
    // decide the author chose wrong.
    const parsed = parseFrontmatter('---\ntitle: T\npublishedAt: 2026-01-01\n---\n')
    const normalised = normaliseFrontmatterKeys(parsed.data)
    const values = formValuesFromFrontmatter(normalised, { status: 'draft' })

    const data = frontmatterFromForm(values, preservedKeys(splitFrontmatterKeys(normalised).known), {
      dateKey: 'publishedAt',
      type: 'post',
    })

    expect(data.publishedAt).toBe('2026-01-01')
    expect(data).not.toHaveProperty('date')
  })
})
