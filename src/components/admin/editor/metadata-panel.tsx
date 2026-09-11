'use client'

import { useState } from 'react'

import { CONTENT_STATUSES, PROJECT_STATUSES, type ContentType } from '@/lib/content/schema'
import type { ContentFormValues } from '@/lib/admin/frontmatter-form'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils/cn'

/**
 * The frontmatter, as a form.
 *
 * Every field here writes a key in the file's YAML header, and the YAML is the
 * document — so the panel is not a set of preferences about the post, it *is*
 * the post's metadata, and the wording says so. Fields the panel does not own
 * are shown rather than hidden: a file with a key nothing in the app reads is
 * still a file somebody wrote, and an editor that silently omits it looks like
 * it dropped it.
 */

const SELECT_CLASS = cn(
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
)

export interface MetadataPanelProps {
  type: ContentType
  values: ContentFormValues
  onChange: (values: ContentFormValues) => void
  /** Keys the writer preserves untouched; shown read-only. */
  preserved: Record<string, unknown>
  /** Per-field messages from the last refused save. */
  errors?: Record<string, string>
  disabled?: boolean
}

export function MetadataPanel({
  type,
  values,
  onChange,
  preserved,
  errors = {},
  disabled = false,
}: MetadataPanelProps) {
  const [showPreserved, setShowPreserved] = useState(false)
  const set = <K extends keyof ContentFormValues>(key: K, value: ContentFormValues[K]) => {
    onChange({ ...values, [key]: value })
  }
  const preservedEntries = Object.entries(preserved)

  return (
    <div className="space-y-5">
      <Field>
        <FieldLabel htmlFor="fm-title" required={type !== 'note'}>
          Title
        </FieldLabel>
        <Input
          id="fm-title"
          value={values.title}
          disabled={disabled}
          onChange={(event) => set('title', event.target.value)}
          aria-invalid={errors.title ? true : undefined}
        />
        {type === 'note' ? (
          <p className="text-xs text-muted-foreground">
            A note may leave this empty; the file&rsquo;s first line is shown instead.
          </p>
        ) : null}
        <FieldError>{errors.title}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="fm-slug">Slug</FieldLabel>
        <Input
          id="fm-slug"
          value={values.slug}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => set('slug', event.target.value)}
          aria-invalid={errors.slug ? true : undefined}
        />
        <p className="text-xs text-muted-foreground">
          The file stays where it is; this changes the URL and the frontmatter only.
        </p>
        <FieldError>{errors.slug}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="fm-description">Description</FieldLabel>
        <Textarea
          id="fm-description"
          rows={3}
          value={values.description}
          disabled={disabled}
          onChange={(event) => set('description', event.target.value)}
          aria-invalid={errors.description ? true : undefined}
        />
        <p className="text-xs text-muted-foreground">
          Used for the summary card, the feed and the meta description.
        </p>
        <FieldError>{errors.description}</FieldError>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="fm-status">Status</FieldLabel>
          <select
            id="fm-status"
            className={SELECT_CLASS}
            value={values.status}
            disabled={disabled}
            onChange={(event) => set('status', event.target.value as ContentFormValues['status'])}
          >
            {CONTENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <FieldError>{errors.status}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="fm-date">Date</FieldLabel>
          <Input
            id="fm-date"
            type="date"
            value={values.date}
            disabled={disabled}
            onChange={(event) => set('date', event.target.value)}
            aria-invalid={errors.date ? true : undefined}
          />
          <FieldError>{errors.date}</FieldError>
        </Field>
      </div>

      {values.status === 'scheduled' || values.publishAt ? (
        <Field>
          <FieldLabel htmlFor="fm-publish-at" required={values.status === 'scheduled'}>
            Publish at
          </FieldLabel>
          <Input
            id="fm-publish-at"
            type="datetime-local"
            value={values.publishAt ? values.publishAt.slice(0, 16) : ''}
            disabled={disabled}
            onChange={(event) => set('publishAt', event.target.value)}
            aria-invalid={errors.publishAt ? true : undefined}
          />
          <p className="text-xs text-muted-foreground">
            A scheduled document goes live when the worker next runs after this moment.
          </p>
          <FieldError>{errors.publishAt}</FieldError>
        </Field>
      ) : null}

      <Field>
        <FieldLabel htmlFor="fm-tags">Tags</FieldLabel>
        <Input
          id="fm-tags"
          value={values.tags.join(', ')}
          disabled={disabled}
          placeholder="writing, tooling"
          onChange={(event) =>
            set(
              'tags',
              event.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            )
          }
          aria-invalid={errors.tags ? true : undefined}
        />
        <p className="text-xs text-muted-foreground">Comma separated.</p>
        <FieldError>{errors.tags}</FieldError>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="fm-category">Category</FieldLabel>
          <Input
            id="fm-category"
            value={values.category}
            disabled={disabled}
            onChange={(event) => set('category', event.target.value)}
            aria-invalid={errors.category ? true : undefined}
          />
          <FieldError>{errors.category}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="fm-series">Series</FieldLabel>
          <Input
            id="fm-series"
            value={values.series}
            disabled={disabled}
            onChange={(event) => set('series', event.target.value)}
            aria-invalid={errors.series ? true : undefined}
          />
          <FieldError>{errors.series}</FieldError>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="fm-cover">Cover</FieldLabel>
        <Input
          id="fm-cover"
          value={values.cover}
          disabled={disabled}
          spellCheck={false}
          placeholder="/uploads/… or https://…"
          onChange={(event) => set('cover', event.target.value)}
          aria-invalid={errors.cover ? true : undefined}
        />
        <FieldError>{errors.cover}</FieldError>
      </Field>

      <Toggle
        id="fm-featured"
        label="Featured"
        hint="Shown on the home page's highlighted list."
        checked={values.featured}
        disabled={disabled}
        onChange={(checked) => set('featured', checked)}
      />
      <Toggle
        id="fm-toc"
        label="Table of contents"
        hint="Rendered from the document's headings."
        checked={values.toc}
        disabled={disabled}
        onChange={(checked) => set('toc', checked)}
      />

      {type === 'project' ? (
        <div className="space-y-5 border-t border-line pt-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
            Project
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="fm-project-status">State</FieldLabel>
              <select
                id="fm-project-status"
                className={SELECT_CLASS}
                value={values.projectStatus}
                disabled={disabled}
                onChange={(event) =>
                  set('projectStatus', event.target.value as ContentFormValues['projectStatus'])
                }
              >
                {PROJECT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <FieldError>{errors.projectStatus}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="fm-started">Started</FieldLabel>
              <Input
                id="fm-started"
                type="date"
                value={values.started}
                disabled={disabled}
                onChange={(event) => set('started', event.target.value)}
                aria-invalid={errors.started ? true : undefined}
              />
              <FieldError>{errors.started}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="fm-repo">Repository</FieldLabel>
            <Input
              id="fm-repo"
              value={values.repo}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => set('repo', event.target.value)}
              aria-invalid={errors.repo ? true : undefined}
            />
            <FieldError>{errors.repo}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="fm-website">Website</FieldLabel>
            <Input
              id="fm-website"
              value={values.website}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => set('website', event.target.value)}
              aria-invalid={errors.website ? true : undefined}
            />
            <FieldError>{errors.website}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="fm-stack">Stack</FieldLabel>
            <Input
              id="fm-stack"
              value={values.stack.join(', ')}
              disabled={disabled}
              placeholder="TypeScript, Postgres"
              onChange={(event) =>
                set(
                  'stack',
                  event.target.value
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter(Boolean),
                )
              }
              aria-invalid={errors.stack ? true : undefined}
            />
            <p className="text-xs text-muted-foreground">Comma separated.</p>
            <FieldError>{errors.stack}</FieldError>
          </Field>
        </div>
      ) : null}

      <details className="border-t border-line pt-5">
        <summary className="cursor-pointer text-xs font-medium text-ink">Search and social</summary>
        <div className="mt-4 space-y-5">
          <Field>
            <FieldLabel htmlFor="fm-seo-title">SEO title</FieldLabel>
            <Input
              id="fm-seo-title"
              value={values.seoTitle}
              disabled={disabled}
              onChange={(event) => set('seoTitle', event.target.value)}
              aria-invalid={errors.seoTitle ? true : undefined}
            />
            <FieldError>{errors.seoTitle}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="fm-seo-description">SEO description</FieldLabel>
            <Textarea
              id="fm-seo-description"
              rows={2}
              value={values.seoDescription}
              disabled={disabled}
              onChange={(event) => set('seoDescription', event.target.value)}
              aria-invalid={errors.seoDescription ? true : undefined}
            />
            <FieldError>{errors.seoDescription}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="fm-seo-canonical">Canonical URL</FieldLabel>
            <Input
              id="fm-seo-canonical"
              value={values.seoCanonical}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => set('seoCanonical', event.target.value)}
              aria-invalid={errors.seoCanonical ? true : undefined}
            />
            <FieldError>{errors.seoCanonical}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="fm-seo-og">Social image</FieldLabel>
            <Input
              id="fm-seo-og"
              value={values.seoOgImage}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => set('seoOgImage', event.target.value)}
              aria-invalid={errors.seoOgImage ? true : undefined}
            />
            <FieldError>{errors.seoOgImage}</FieldError>
          </Field>
          <Toggle
            id="fm-seo-noindex"
            label="Keep out of search engines"
            hint="Writes seo.noindex; the page still renders and is still listed here, but it leaves the sitemap and the feeds."
            checked={values.seoNoindex}
            disabled={disabled}
            onChange={(checked) => set('seoNoindex', checked)}
          />
        </div>
      </details>

      {preservedEntries.length > 0 ? (
        <div className="border-t border-line pt-5">
          <button
            type="button"
            className="text-xs font-medium text-ink"
            aria-expanded={showPreserved}
            onClick={() => setShowPreserved((open) => !open)}
          >
            {showPreserved ? 'Hide' : 'Show'} {preservedEntries.length} key
            {preservedEntries.length === 1 ? '' : 's'} kept as written
          </button>
          <p className="mt-1 text-xs text-muted-foreground">
            Not edited here. Saving writes them back unchanged.
          </p>
          {showPreserved ? (
            <dl className="mt-3 space-y-1.5">
              {preservedEntries.map(([key, value]) => (
                <div key={key} className="flex gap-3 text-xs">
                  <dt className="w-28 shrink-0 font-mono text-ink-muted">{key}</dt>
                  <dd className="min-w-0 break-words font-mono text-ink">
                    {formatPreservedValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium leading-none text-ink">
          {label}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

function formatPreservedValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value || '""'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(formatPreservedValue).join(', ')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[unreadable]'
    }
  }
  return String(value)
}
