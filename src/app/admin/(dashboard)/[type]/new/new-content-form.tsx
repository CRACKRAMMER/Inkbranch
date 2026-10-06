'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { createContentAction } from '@/app/admin/actions/content'
import type { ContentType } from '@/lib/content/schema'

/**
 * The create form.
 *
 * The slug follows the title until it is touched, then stops — a URL is a
 * decision, and an editor that rewrites a URL someone typed is worse than one
 * that leaves it alone.
 */
export function NewContentForm({ type, segment }: { type: ContentType; segment: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [status, setStatus] = useState<'draft' | 'published'>('draft')
  const [date, setDate] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [savedSlug, setSavedSlug] = useState<string | null>(null)

  const effectiveSlug = slugTouched ? slug : slugify(title)

  function submit() {
    setErrors({})
    setFailure(null)
    setSavedSlug(null)

    startTransition(async () => {
      const result = await createContentAction({
        type,
        title: title.trim(),
        slug: effectiveSlug,
        status,
        date,
      })

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {})
        setFailure(result.detail ? `${result.error} ${result.detail}` : result.error)
        setSavedSlug(result.committed?.find((change) => change.operation === 'write')?.slug ?? null)
        return
      }

      const { slug: created } = result.data
      router.push(`/admin/${segment}/${created}/edit`)
      router.refresh()
    })
  }

  return (
    <form
      className="flex flex-col gap-6 border-y border-line py-6"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      noValidate
    >
      <Field>
        <FieldLabel htmlFor="title" required>
          Title
        </FieldLabel>
        <Input
          id="title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoFocus
          maxLength={300}
          aria-invalid={Boolean(errors.title) || undefined}
          aria-describedby={errors.title ? 'title-error' : undefined}
        />
        <FieldError id="title-error">{errors.title}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="slug" required>
          Slug
        </FieldLabel>
        <Input
          id="slug"
          name="slug"
          value={effectiveSlug}
          onChange={(event) => {
            setSlugTouched(true)
            setSlug(event.target.value)
          }}
          maxLength={200}
          className="font-mono"
          aria-invalid={Boolean(errors.slug) || undefined}
          aria-describedby="slug-description"
        />
        <FieldDescription id="slug-description">
          The URL, relative to <span className="font-mono">/{segment}/</span>. Lowercase letters,
          digits and hyphens. Renaming later does not move the file.
        </FieldDescription>
        <FieldError id="slug-error">{errors.slug}</FieldError>
      </Field>

      <div className="flex flex-wrap gap-6">
        <Field className="min-w-40">
          <FieldLabel htmlFor="status">Status</FieldLabel>
          <select
            id="status"
            name="status"
            value={status}
            onChange={(event) => setStatus(event.target.value === 'published' ? 'published' : 'draft')}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
          <FieldDescription>
            Scheduled and archived are set in the editor, where the publish time is next to the
            preview.
          </FieldDescription>
        </Field>

        <Field className="min-w-40">
          <FieldLabel htmlFor="date">Date</FieldLabel>
          <Input
            id="date"
            name="date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            aria-invalid={Boolean(errors.date) || undefined}
          />
          <FieldDescription>Leave blank to use today. Required to publish.</FieldDescription>
          <FieldError id="date-error">{errors.date}</FieldError>
        </Field>
      </div>

      {failure ? (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
          {failure}
        </p>
      ) : null}
      {savedSlug ? <Link href={`/admin/${segment}/${savedSlug}/edit`} className="text-sm underline">Open the saved file</Link> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || title.trim() === ''}>
          {pending ? 'Creating…' : 'Create and edit'}
        </Button>
        <p className="text-xs text-ink-subtle">
          Nothing is written until you press this. The editor then opens on the new file.
        </p>
      </div>
    </form>
  )
}

/**
 * Derive a URL-safe slug from a title.
 *
 * Non-ASCII titles (Chinese, for instance) have no sensible transliteration
 * here, so the result is empty and the field is left for the author to fill in
 * rather than being filled with something wrong.
 */
function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
