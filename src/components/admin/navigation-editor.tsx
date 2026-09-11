'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { saveNavigationAction } from '@/app/admin/actions/navigation'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { NavigationLocation } from '@/lib/navigation'
import { cn } from '@/lib/utils/cn'

/**
 * One menu, edited as a list and saved whole.
 *
 * `saveNavigation` replaces a menu rather than patching it, so the editor holds
 * the whole list in local state and posts it in one request — which is also why
 * reordering is a move up/down rather than a drag: the position is the array
 * index, and a keyboard user can do everything a mouse user can.
 *
 * Nothing is saved until Save is pressed. A menu is small, and a half-typed link
 * going live because a field lost focus is a worse failure than losing an
 * unsaved row when the tab closes.
 */

export interface NavigationEditorItem {
  label: string
  href: string
  visible: boolean
  external: boolean
  icon: string | null
}

export function NavigationEditor({
  location,
  title,
  description,
  items,
  /** Shown as a suggestion list; the field accepts any name. */
  iconSuggestions = [],
}: {
  /**
   * The menu being edited. Typed as the union rather than `string` so a typo in
   * a call site is a compile error here instead of a refused save at run time —
   * the action validates it, but only after the author has pressed Save.
   *
   * A type-only import, so nothing server-side is pulled into this bundle.
   */
  location: NavigationLocation
  title: string
  description: string
  items: NavigationEditorItem[]
  iconSuggestions?: string[]
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<NavigationEditorItem[]>(items)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const dirty = JSON.stringify(draft) !== JSON.stringify(items)
  const listId = `nav-icons-${location}`

  function update(index: number, patch: Partial<NavigationEditorItem>) {
    setDraft((current) =>
      current.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    )
  }

  function move(index: number, delta: number) {
    setDraft((current) => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const [moved] = next.splice(index, 1)
      if (!moved) return current
      next.splice(target, 0, moved)
      return next
    })
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await saveNavigationAction({
        // The action validates this against the module's own list of locations;
        // naming that type here would mean importing a server-only module into
        // a client component for a string union.
        location,
        items: draft,
      })
      if (!result.ok) {
        setError({ message: result.error, detail: result.detail })
        return
      }
      toast.success(`${title} saved.`, {
        description: `${result.data.items.length} item${result.data.items.length === 1 ? '' : 's'}.`,
      })
      router.refresh()
    })
  }

  return (
    <div className="border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-sunken px-3 py-2">
        <div>
          <h3 className="text-sm font-medium text-ink">{title}</h3>
          <p className="mt-0.5 max-w-[36rem] text-xs leading-relaxed text-ink-muted">
            {description}
          </p>
        </div>
        <span className="text-xs tabular text-ink-subtle">
          {draft.filter((item) => item.visible).length} visible / {draft.length}
        </span>
      </div>

      {draft.length === 0 ? (
        <p className="px-3 py-4 text-sm text-ink-muted">
          This menu is empty, so nothing renders for it.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {draft.map((item, index) => (
            <li key={index} className="px-3 py-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field className="w-40">
                  <FieldLabel htmlFor={`${location}-label-${index}`}>Label</FieldLabel>
                  <Input
                    id={`${location}-label-${index}`}
                    value={item.label}
                    autoComplete="off"
                    onChange={(event) => update(index, { label: event.target.value })}
                  />
                </Field>

                <Field className="min-w-[14rem] flex-1">
                  <FieldLabel htmlFor={`${location}-href-${index}`}>Destination</FieldLabel>
                  <Input
                    id={`${location}-href-${index}`}
                    value={item.href}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => update(index, { href: event.target.value })}
                  />
                </Field>

                {location === 'social' ? (
                  <Field className="w-36">
                    <FieldLabel htmlFor={`${location}-icon-${index}`}>Icon</FieldLabel>
                    <Input
                      id={`${location}-icon-${index}`}
                      value={item.icon ?? ''}
                      list={listId}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => update(index, { icon: event.target.value || null })}
                    />
                  </Field>
                ) : null}

                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    ↑<span className="sr-only">Move {item.label} up</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => move(index, 1)}
                    disabled={index === draft.length - 1}
                    title="Move down"
                  >
                    ↓<span className="sr-only">Move {item.label} down</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                <label className="inline-flex items-center gap-2 text-ink-muted">
                  <input
                    type="checkbox"
                    checked={item.visible}
                    onChange={(event) => update(index, { visible: event.target.checked })}
                    className="size-3.5 accent-[var(--color-brand)]"
                  />
                  Visible
                </label>
                <label className="inline-flex items-center gap-2 text-ink-muted">
                  <input
                    type="checkbox"
                    checked={item.external}
                    onChange={(event) => update(index, { external: event.target.checked })}
                    className="size-3.5 accent-[var(--color-brand)]"
                  />
                  Opens on another site
                </label>
                <span
                  className={cn(
                    'font-mono',
                    item.href.startsWith('/') || item.external ? 'text-ink-subtle' : 'text-danger',
                  )}
                >
                  {item.href.startsWith('/') || item.external
                    ? ''
                    : 'A destination that is not a site path should be marked external.'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {iconSuggestions.length > 0 ? (
        <datalist id={listId}>
          {iconSuggestions.map((icon) => (
            <option key={icon} value={icon} />
          ))}
        </datalist>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            setDraft((current) => [
              ...current,
              { label: '', href: '', visible: true, external: false, icon: null },
            ])
          }
        >
          Add item
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={pending || !dirty}>
          {pending ? 'Saving…' : 'Save menu'}
        </Button>
        {dirty && !pending ? (
          <span className="text-xs text-ink-muted">Unsaved changes</span>
        ) : null}
      </div>

      {location === 'social' ? (
        <p className="border-t border-line px-3 py-2 text-xs text-ink-muted">
          Icons are Lucide names. A name that is not a real icon renders as nothing at all, and the
          menu still works — the label is what a reader sees.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="border-t border-danger/40 px-3 py-2 text-sm text-ink">
          {error.message}
          {error.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{error.detail}</span>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

/** The names the footer's social list is most likely to want. */
export const SOCIAL_ICON_SUGGESTIONS = [
  'github',
  'twitter',
  'linkedin',
  'mastodon',
  'bluesky',
  'rss',
  'mail',
  'youtube',
  'instagram',
  'facebook',
  'telegram',
  'globe',
  'link',
  'external-link',
]
