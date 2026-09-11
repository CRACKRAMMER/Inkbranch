'use client'

import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Section } from '@/components/admin/page'
import { useUnsavedGuard } from '@/components/admin/unsaved-guard'
import { updateSettingsAction } from '@/app/admin/actions/settings'
import { SETTINGS_KEYS, type Settings, type SettingsKey } from '@/lib/settings/schema'

/**
 * The settings form.
 *
 * One form for every field in `settingsPatchSchema`, saved as a patch of the
 * keys that actually changed. Two consequences are deliberate:
 *
 * - **Saving sends only what was touched.** A field this page renders in a
 *   broken state, or one an operator never opened, cannot be written by
 *   accident — and two people editing different sections do not overwrite each
 *   other's work.
 * - **`Discard` is a real reset.** It re-reads from the server props rather than
 *   from a copy taken at mount, so after a save it discards back to what was
 *   saved, not to what the page started with.
 *
 * Fields that nothing in this build reads yet — the git integration, the
 * comments flag, the analytics flag — say so next to themselves. A switch that
 * claims to turn something on, in a build where nothing is listening, is worse
 * than a missing switch.
 */

const UNSAVED_MESSAGE = 'Site settings have changes that were not saved. Leave anyway?'

/** Time zones offered as suggestions; the field is free text and validated on save. */
const TIME_ZONE_SUGGESTIONS = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
]

interface Api {
  draft: Settings
  set: <K extends SettingsKey>(key: K, value: Settings[K]) => void
  errorFor: (key: string) => string | undefined
}

export function SettingsForm({ settings }: { settings: Settings }) {
  const router = useRouter()

  const [draft, setDraft] = useState<Settings>(settings)
  const [baseline, setBaseline] = useState<Settings>(settings)
  const [customText, setCustomText] = useState(() => serializeCustom(settings.custom))
  const [customError, setCustomError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // The server is the source of truth after a save or a revalidation; adopting
  // its props keeps the form from drifting from the row it is editing.
  const [seen, setSeen] = useState(settings)
  if (seen !== settings) {
    setSeen(settings)
    setDraft(settings)
    setBaseline(settings)
    setCustomText(serializeCustom(settings.custom))
    setCustomError(null)
  }

  const dirty = useMemo(() => changedKeys(baseline, draft), [baseline, draft])
  const dirtyRef = useRef(false)

  useEffect(() => {
    dirtyRef.current = dirty.length > 0
  }, [dirty.length])

  useUnsavedGuard(dirtyRef, UNSAVED_MESSAGE)

  const api: Api = {
    draft,
    set: (key, value) => setDraft((current) => ({ ...current, [key]: value })),
    errorFor: (key) => fieldErrors[key] ?? firstNestedError(fieldErrors, key),
  }

  function onCustomText(text: string) {
    setCustomText(text)
    const parsed = parseCustom(text)
    if (!parsed.ok) {
      setCustomError(parsed.message)
      return
    }
    setCustomError(null)
    api.set('custom', parsed.value)
  }

  function save() {
    setFailure(null)
    setFieldErrors({})

    if (customError) {
      setFailure({ message: 'The custom settings are not valid JSON, so nothing was saved.' })
      return
    }

    const patch: Record<string, unknown> = {}
    for (const key of dirty) patch[key] = draft[key]

    startTransition(async () => {
      const result = await updateSettingsAction(patch)
      if (!result.ok) {
        setFailure({ message: result.error, detail: result.detail })
        if (result.fieldErrors) setFieldErrors(result.fieldErrors)
        return
      }

      setDraft(result.data.settings)
      setBaseline(result.data.settings)
      setCustomText(serializeCustom(result.data.settings.custom))
      setSavedAt(new Date().toLocaleTimeString())
      toast.success(
        `Saved ${result.data.keys.length} setting${result.data.keys.length === 1 ? '' : 's'}.`,
        { description: result.data.keys.join(', ') },
      )
      router.refresh()
    })
  }

  const blocked = dirty.length === 0 || customError !== null

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked && !pending) save()
      }}
    >
      <IdentitySection api={api} />
      <SeoSection api={api} />
      <FeaturesSection api={api} />
      <RevisionsSection api={api} />
      <GitSection api={api} />
      <AboutSection api={api} />
      <CustomSection
        value={customText}
        error={customError}
        onChange={onCustomText}
        storedKeyCount={Object.keys(baseline.custom ?? {}).length}
      />

      <div className="sticky bottom-0 z-10 mt-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-canvas py-4">
        <p aria-live="polite" className="text-xs text-ink-muted">
          {customError
            ? 'Fix the custom settings before saving.'
            : dirty.length === 0
              ? savedAt
                ? `All changes saved at ${savedAt}.`
                : 'No unsaved changes.'
              : `${dirty.length} unsaved change${dirty.length === 1 ? '' : 's'}: ${dirty.join(', ')}.`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending || dirty.length === 0}
            onClick={() => {
              setDraft(baseline)
              setCustomText(serializeCustom(baseline.custom))
              setCustomError(null)
              setFailure(null)
              setFieldErrors({})
            }}
          >
            Discard changes
          </Button>
          <Button type="submit" size="sm" disabled={pending || blocked}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      {failure ? (
        <p role="alert" className="mt-4 border-l-2 border-danger pl-3 text-sm text-ink">
          {failure.message}
          {failure.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{failure.detail}</span>
          ) : null}
        </p>
      ) : null}
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/*  Sections                                                                   */
/* -------------------------------------------------------------------------- */

function IdentitySection({ api }: { api: Api }) {
  return (
    <Section
      title="Identity"
      description="Who the site is. These are read by the header, the footer, the feeds and every page's metadata."
    >
      <div className="space-y-4">
        <TextField
          id="setting-siteName"
          label="Site name"
          required
          value={api.draft.siteName}
          error={api.errorFor('siteName')}
          description="The name in the header, the feed title and the default page title."
          onChange={(value) => api.set('siteName', value)}
        />
        <TextAreaField
          id="setting-siteDescription"
          label="Site description"
          rows={3}
          value={api.draft.siteDescription}
          error={api.errorFor('siteDescription')}
          description="The default description for anything that does not set its own; the home page uses it verbatim."
          onChange={(value) => api.set('siteDescription', value)}
        />
        <TextField
          id="setting-authorName"
          label="Author name"
          value={api.draft.authorName}
          error={api.errorFor('authorName')}
          description="The byline, and the author in structured data and the feed."
          onChange={(value) => api.set('authorName', value)}
        />
        <TextField
          id="setting-tagline"
          label="Tagline"
          value={api.draft.tagline}
          error={api.errorFor('tagline')}
          description="One short line under the site name on the home page."
          onChange={(value) => api.set('tagline', value)}
        />
        <NullableTextField
          id="setting-avatarUrl"
          label="Avatar URL"
          value={api.draft.avatarUrl}
          error={api.errorFor('avatarUrl')}
          placeholder="/uploads/2026/01/avatar.png"
          description="A site-relative path or an absolute http(s) URL. Nothing renders it yet; the asset delete guard does read it, and refuses to delete the image it points at."
          onChange={(value) => api.set('avatarUrl', value)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="setting-locale"
            label="Locale"
            value={api.draft.locale}
            error={api.errorFor('locale')}
            mono
            placeholder="zh-CN"
            description="A BCP-47 tag. Drives date and number formatting and the page's lang attribute."
            onChange={(value) => api.set('locale', value)}
          />
          <TextField
            id="setting-timezone"
            label="Time zone"
            value={api.draft.timezone}
            error={api.errorFor('timezone')}
            mono
            list="setting-timezone-suggestions"
            placeholder="Asia/Shanghai"
            description="An IANA zone, used wherever a date is shown in the site's own time."
            onChange={(value) => api.set('timezone', value)}
          />
          <datalist id="setting-timezone-suggestions">
            {TIME_ZONE_SUGGESTIONS.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>
      </div>
    </Section>
  )
}

function SeoSection({ api }: { api: Api }) {
  return (
    <Section
      title="Search and social"
      description="What a crawler and a link preview read."
    >
      <div className="space-y-4">
        <TextField
          id="setting-seoTitleTemplate"
          label="Title template"
          required
          value={api.draft.seoTitleTemplate}
          error={api.errorFor('seoTitleTemplate')}
          mono
          placeholder="%s · My Blog"
          description="Must contain %s, which is replaced by the page title. Without it every page in the site loses its own title at once."
          onChange={(value) => api.set('seoTitleTemplate', value)}
        />
        <TextAreaField
          id="setting-seoDefaultDescription"
          label="Default description"
          rows={3}
          value={api.draft.seoDefaultDescription}
          error={api.errorFor('seoDefaultDescription')}
          description="Used when a document has no description of its own. Somewhere under 160 characters is what search results show."
          onChange={(value) => api.set('seoDefaultDescription', value)}
        />
        <NullableTextField
          id="setting-twitterHandle"
          label="Twitter handle"
          value={api.draft.twitterHandle}
          error={api.errorFor('twitterHandle')}
          placeholder="without the @"
          description="Written into the Twitter card metadata."
          onChange={(value) => api.set('twitterHandle', value)}
        />
        <NullableTextField
          id="setting-googleVerification"
          label="Google site verification"
          value={api.draft.googleVerification}
          error={api.errorFor('googleVerification')}
          description="The content value of the verification meta tag. Stored, but nothing in this build renders the tag yet — adding it here will not verify the site."
          onChange={(value) => api.set('googleVerification', value)}
        />
      </div>
    </Section>
  )
}

function FeaturesSection({ api }: { api: Api }) {
  return (
    <Section
      title="Features"
      description="Switches for the site's optional surfaces."
    >
      <div className="divide-y divide-line border-y border-line">
        <ToggleField
          id="setting-searchEnabled"
          label="Site search"
          checked={api.draft.searchEnabled}
          description="Shows the search page and the header's search link. Read by the site layout."
          onChange={(value) => api.set('searchEnabled', value)}
        />
        <ToggleField
          id="setting-graphEnabled"
          label="Link graph"
          checked={api.draft.graphEnabled}
          description="Shows the graph page. Read by the graph route."
          onChange={(value) => api.set('graphEnabled', value)}
        />
        <ToggleField
          id="setting-rssEnabled"
          label="Feeds"
          checked={api.draft.rssEnabled}
          description="Exposes /rss.xml and /atom.xml, and links them from the page head."
          onChange={(value) => api.set('rssEnabled', value)}
        />
        <ToggleField
          id="setting-commentsEnabled"
          label="Comments"
          checked={api.draft.commentsEnabled}
          description="Stored, and read by nothing: this build has no comments feature. Turning it on changes no page."
          onChange={(value) => api.set('commentsEnabled', value)}
        />
        <ToggleField
          id="setting-analyticsEnabled"
          label="Analytics"
          checked={api.draft.analyticsEnabled}
          description="Records page views, rolled up into daily totals and read by the analytics page. The site sends nothing unless this and ANALYTICS_ENABLED are both on, so switching it off here stops collection without a redeploy — though a browser holding a cached page still has the old markup."
          onChange={(value) => api.set('analyticsEnabled', value)}
        />
        <div className="py-3">
          <NumberField
            id="setting-rssItemLimit"
            label="Feed length"
            min={1}
            max={200}
            value={api.draft.rssItemLimit}
            error={api.errorFor('rssItemLimit')}
            description="How many items /rss.xml and /atom.xml carry, newest first."
            onChange={(value) => api.set('rssItemLimit', value)}
          />
        </div>
      </div>
    </Section>
  )
}

function RevisionsSection({ api }: { api: Api }) {
  return (
    <Section
      title="Revisions"
      description="What the editor keeps in the database as you work."
    >
      <div className="divide-y divide-line border-y border-line">
        <ToggleField
          id="setting-revisionsEnabled"
          label="Record revisions"
          checked={api.draft.revisionsEnabled}
          description="With this off, no revision rows are written at all — not on save, and not the draft autosave takes while you type."
          onChange={(value) => api.set('revisionsEnabled', value)}
        />
        <div className="py-3">
          <NumberField
            id="setting-revisionsMaxPerContent"
            label="Revisions kept per document"
            min={1}
            max={1000}
            value={api.draft.revisionsMaxPerContent}
            error={api.errorFor('revisionsMaxPerContent')}
            description="The oldest are pruned when a new one is captured. Lowering this does not delete anything immediately — the next capture on a document trims it."
            onChange={(value) => api.set('revisionsMaxPerContent', value)}
          />
        </div>
      </div>
    </Section>
  )
}

function GitSection({ api }: { api: Api }) {
  return (
    <Section
      title="Git"
      description="Commits the content directory after a save. Two switches have to agree: this one, and GIT_INTEGRATION_ENABLED in the server environment, which is off by default and which only the operator who starts the process can set. When this page asks for commits and the environment refuses, the editor says so after every save. Nothing here ever pushes."
    >
      <div className="divide-y divide-line border-y border-line">
        <ToggleField
          id="setting-gitEnabled"
          label="Git integration"
          checked={api.draft.gitEnabled}
          description="The content directory has to be a git repository — or inside one — with a user.name and user.email configured, and git has to be installed on the server. A commit that cannot happen is reported in the editor and the server log; the file is written either way."
          onChange={(value) => api.set('gitEnabled', value)}
        />
        <ToggleField
          id="setting-gitAutoCommit"
          label="Commit content changes automatically"
          checked={api.draft.gitAutoCommit}
          description="One commit per save, per deletion, per revision restore, and one for a bulk or tag operation however many documents it touched. Only the files that operation changed are staged, so nothing you have staged yourself rides along."
          onChange={(value) => api.set('gitAutoCommit', value)}
        />
        <div className="py-3">
          <TextField
            id="setting-gitCommitTemplate"
            label="Commit message template"
            value={api.draft.gitCommitTemplate}
            error={api.errorFor('gitCommitTemplate')}
            mono
            placeholder='content: {action} "{title}"'
            description="Placeholders are {action} — create, update, publish, unpublish, delete, restore or tag — and {title}. A template with no placeholders is used as it is."
            onChange={(value) => api.set('gitCommitTemplate', value)}
          />
        </div>
      </div>
    </Section>
  )
}

function AboutSection({ api }: { api: Api }) {
  return (
    <Section
      title="About page"
      description="The prose and the lists /about renders. Everything here is optional; an empty list is an absent section, not an empty heading."
    >
      <div className="space-y-6">
        <TextAreaField
          id="setting-aboutProfile"
          label="Profile"
          rows={6}
          value={api.draft.aboutProfile}
          error={api.errorFor('aboutProfile')}
          description="Plain text or Markdown. The body of the about page."
          onChange={(value) => api.set('aboutProfile', value)}
        />

        <EntryList
          id="aboutFocus"
          label="Focus areas"
          description="Short phrases, rendered as a list."
          items={api.draft.aboutFocus}
          error={api.errorFor('aboutFocus')}
          create={() => ''}
          addLabel="Add a focus area"
          onChange={(next) => api.set('aboutFocus', next)}
          render={(item, update) => (
            <Input
              aria-label="Focus area"
              value={item}
              placeholder="Type systems"
              onChange={(event) => update(() => event.target.value)}
            />
          )}
          summarize={(item, index) => (item.trim() ? item : `focus area ${index + 1}`)}
        />

        <EntryList
          id="aboutCurrently"
          label="Currently"
          description="A label and a value per row."
          items={api.draft.aboutCurrently}
          error={api.errorFor('aboutCurrently')}
          create={() => ({ label: '', value: '' })}
          addLabel="Add a row"
          onChange={(next) => api.set('aboutCurrently', next)}
          render={(item, update) => (
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
              <Input
                aria-label="Label"
                value={item.label}
                placeholder="Reading"
                onChange={(event) => update((current) => ({ ...current, label: event.target.value }))}
              />
              <Input
                aria-label="Value"
                value={item.value}
                placeholder="A book"
                onChange={(event) => update((current) => ({ ...current, value: event.target.value }))}
              />
            </div>
          )}
          summarize={(item, index) => item.label.trim() || `row ${index + 1}`}
        />

        <EntryList
          id="aboutStack"
          label="Stack"
          description="A group and the things in it, one per line."
          items={api.draft.aboutStack}
          error={api.errorFor('aboutStack')}
          create={() => ({ group: '', items: [] })}
          addLabel="Add a group"
          onChange={(next) => api.set('aboutStack', next)}
          render={(item, update) => (
            <div className="space-y-2">
              <Input
                aria-label="Group"
                value={item.group}
                placeholder="Languages"
                onChange={(event) => update((current) => ({ ...current, group: event.target.value }))}
              />
              <Textarea
                aria-label="Items, one per line"
                rows={3}
                value={item.items.join('\n')}
                placeholder={'TypeScript\nGo'}
                onChange={(event) =>
                  update((current) => ({ ...current, items: linesToItems(event.target.value) }))
                }
              />
            </div>
          )}
          summarize={(item, index) => item.group.trim() || `group ${index + 1}`}
        />

        <EntryList
          id="aboutContact"
          label="Contact"
          description="A label and a destination. A mailto: link is allowed here and nowhere else."
          items={api.draft.aboutContact}
          error={api.errorFor('aboutContact')}
          create={() => ({ label: '', href: '' })}
          addLabel="Add a contact"
          onChange={(next) => api.set('aboutContact', next)}
          render={(item, update) => (
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
              <Input
                aria-label="Label"
                value={item.label}
                placeholder="Email"
                onChange={(event) => update((current) => ({ ...current, label: event.target.value }))}
              />
              <Input
                aria-label="Destination"
                value={item.href}
                placeholder="mailto:me@example.com"
                onChange={(event) => update((current) => ({ ...current, href: event.target.value }))}
              />
            </div>
          )}
          summarize={(item, index) => item.label.trim() || `contact ${index + 1}`}
        />
      </div>
    </Section>
  )
}

function CustomSection({
  value,
  error,
  onChange,
  storedKeyCount,
}: {
  value: string
  error: string | null
  onChange: (text: string) => void
  storedKeyCount: number
}) {
  const id = useId()

  return (
    <Section
      title="Custom"
      description="A JSON object for keys that have no column of their own. Nothing in the site reads them today, and they are reserved for that purpose rather than for duplicating a typed setting — a custom key that repeats one (siteName, timezone) sits here unread while the column above holds what is actually rendered."
    >
      <Field>
        <FieldLabel htmlFor={id}>Custom settings</FieldLabel>
        <Textarea
          id={id}
          rows={8}
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs"
        />
        <FieldDescription>
          {storedKeyCount} key{storedKeyCount === 1 ? '' : 's'} stored. A save merges this object into
          what is stored rather than replacing it, so a key you delete here stays in the database until
          something else removes it — this page cannot delete a custom key.
        </FieldDescription>
        <FieldError>{error ?? undefined}</FieldError>
      </Field>
    </Section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Fields                                                                     */
/* -------------------------------------------------------------------------- */

function TextField({
  id,
  label,
  value,
  onChange,
  description,
  error,
  placeholder,
  required = false,
  mono = false,
  list,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  description?: string
  error?: string
  placeholder?: string
  required?: boolean
  mono?: boolean
  list?: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        list={list}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        className={mono ? 'font-mono text-xs' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

function TextAreaField({
  id,
  label,
  value,
  onChange,
  description,
  error,
  rows,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  description?: string
  error?: string
  rows: number
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

/**
 * A field the schema allows to be `null`.
 *
 * An empty box is the null, and that is the only conversion: `twitterHandle` is
 * nullable so that a site without one omits the meta tag rather than emitting an
 * empty one, and an empty string is not the same value.
 */
function NullableTextField({
  id,
  label,
  value,
  onChange,
  description,
  error,
  placeholder,
}: {
  id: string
  label: string
  value: string | null
  onChange: (value: string | null) => void
  description?: string
  error?: string
  placeholder?: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value ?? ''}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value.trim() === '' ? null : event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

/**
 * A bounded integer.
 *
 * The text is held locally so that clearing the box is possible: a controlled
 * number input wired straight to the parsed value refuses to be emptied, because
 * the empty string parses to a value the field immediately rejects. Only a
 * parsed integer is reported upward, and the box says when it is not one.
 */
function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  description,
  error,
}: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  description?: string
  error?: string
}) {
  const [text, setText] = useState(String(value))
  const [seen, setSeen] = useState(value)
  const [localError, setLocalError] = useState<string | null>(null)

  if (seen !== value) {
    setSeen(value)
    setText(String(value))
    setLocalError(null)
  }

  return (
    <Field className="max-w-xs">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        aria-invalid={localError || error ? true : undefined}
        className="font-mono text-xs"
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          const parsed = Number(next)
          if (next.trim() === '' || !Number.isInteger(parsed)) {
            setLocalError(`Enter a whole number between ${min} and ${max}.`)
            return
          }
          if (parsed < min || parsed > max) {
            setLocalError(`Must be between ${min} and ${max}.`)
            return
          }
          setLocalError(null)
          onChange(parsed)
        }}
        onBlur={() => {
          // Leaving the field with unusable text puts the last good value back,
          // so the box never shows a number the form is not going to save.
          if (localError) {
            setText(String(seen))
            setLocalError(null)
          }
        }}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{localError ?? error}</FieldError>
    </Field>
  )
}

function ToggleField({
  id,
  label,
  checked,
  onChange,
  description,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  description?: string
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
        {description ? (
          <p className="mt-1 max-w-[36rem] text-xs leading-relaxed text-ink-muted">{description}</p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Lists of entries                                                           */
/* -------------------------------------------------------------------------- */

interface EntryListProps<T> {
  id: string
  label: string
  description?: string
  items: T[]
  error?: string
  create: () => T
  addLabel: string
  onChange: (next: T[]) => void
  render: (item: T, update: (change: (current: T) => T) => void) => React.ReactNode
  summarize: (item: T, index: number) => string
}

/**
 * An ordered list of small records, edited in place.
 *
 * Rows are moved with buttons rather than by dragging: the order is the data
 * (the about page renders these in sequence), a drag is invisible to a keyboard
 * and to a screen reader, and a button pair costs less than a drag
 * implementation that would need both.
 */
function EntryList<T>({
  id,
  label,
  description,
  items,
  error,
  create,
  addLabel,
  onChange,
  render,
  summarize,
}: EntryListProps<T>) {
  const descriptionId = `${id}-description`

  function update(index: number, change: (current: T) => T) {
    onChange(items.map((item, at) => (at === index ? change(item) : item)))
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    const moved = next[index]
    const displaced = next[target]
    if (moved === undefined || displaced === undefined) return
    next[index] = displaced
    next[target] = moved
    onChange(next)
  }

  return (
    <fieldset aria-describedby={description ? descriptionId : undefined}>
      <legend className="text-sm text-ink">{label}</legend>
      {description ? (
        <p id={descriptionId} className="mt-1 max-w-[36rem] text-xs leading-relaxed text-ink-muted">
          {description}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="mt-2 text-xs text-ink-subtle">None yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item, index) => (
            <li key={index} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">{render(item, (change) => update(index, change))}</div>
              <div className="flex shrink-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={index === 0}
                  aria-label={`Move ${summarize(item, index)} up`}
                  onClick={() => move(index, -1)}
                >
                  <span aria-hidden="true">↑</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={index === items.length - 1}
                  aria-label={`Move ${summarize(item, index)} down`}
                  onClick={() => move(index, 1)}
                >
                  <span aria-hidden="true">↓</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${summarize(item, index)}`}
                  onClick={() => onChange(items.filter((_, at) => at !== index))}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={() => onChange([...items, create()])}
      >
        {addLabel}
      </Button>

      <FieldError>{error}</FieldError>
    </fieldset>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function changedKeys(a: Settings, b: Settings): SettingsKey[] {
  return SETTINGS_KEYS.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
}

/**
 * The first message for a nested field, e.g. `aboutFocus.0` for `aboutFocus`.
 *
 * Zod reports the index inside the array, and the form has one control per row
 * rather than one per array; showing the first problem under the list is the
 * honest granularity — the row itself is visible right there.
 */
function firstNestedError(errors: Record<string, string>, key: string): string | undefined {
  for (const [path, message] of Object.entries(errors)) {
    if (path.startsWith(`${key}.`)) return message
  }
  return undefined
}

function linesToItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function serializeCustom(value: Record<string, unknown>): string {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseCustom(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `Not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'Custom settings must be a JSON object, e.g. {"key": "value"}.' }
  }

  return { ok: true, value: parsed as Record<string, unknown> }
}
