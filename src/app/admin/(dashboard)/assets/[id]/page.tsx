import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireUser } from '@/lib/auth/session'
import { findAssetReferences, getAsset } from '@/lib/assets/manage'
import { formatDate } from '@/lib/utils/date'
import { formatBytes } from '@/lib/utils/format'
import { getSettings } from '@/lib/settings'
import { segmentForType } from '@/lib/admin/routes'
import { InlineNote, Page, Section } from '@/components/admin/page'
import { AltTextForm, CopyUrlButton, DeleteAssetButton } from '@/components/admin/asset-controls'
import { StatusBadge } from '@/components/admin/status-badge'
import { Badge } from '@/components/ui/badge'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const asset = await getAsset(id).catch(() => null)
  return { title: asset ? `Asset · ${asset.filename}` : 'Asset' }
}

/**
 * One asset: what it is, what points at it, and what can be done about it.
 *
 * The reference list is the reason this page exists. `deleteAsset` refuses when
 * anything still points at the file and hands back the documents that do — but a
 * refusal is a poor place to discover that a hero image is load-bearing, so the
 * list is rendered here, before anyone asks for a delete.
 */
export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser()

  const { id } = await params
  const asset = await getAsset(id).catch(() => null)
  if (!asset) notFound()

  const [usage, settings] = await Promise.all([findAssetReferences(asset.id), getSettings()])
  const context = { locale: settings.locale, timeZone: settings.timezone, now: new Date() }
  const documents = usage?.documents ?? []
  const inUse = documents.length > 0 || usage?.usedAsSiteAvatar === true

  return (
    <Page
      eyebrow="Asset"
      title={asset.filename}
      description={
        <>
          Stored at <span className="font-mono">{asset.path}</span>. Uploaded{' '}
          {formatDate(asset.createdAt, context)}.
        </>
      }
      actions={
        <>
          <Link href="/admin/assets" className="text-sm text-ink-muted hover:text-brand">
            ← All assets
          </Link>
          <DeleteAssetButton id={asset.id} filename={asset.filename} view="detail" />
        </>
      }
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0">
          <div className="flex aspect-[4/3] items-center justify-center border border-line bg-sunken">
            {asset.mime.startsWith('image/') ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={asset.url}
                alt={asset.alt ?? ''}
                decoding="async"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="font-mono text-xs text-ink-subtle">{asset.mime}</span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 break-all border border-line bg-sunken px-2 py-1.5 font-mono text-xs text-ink-muted">
              {asset.url}
            </code>
            <CopyUrlButton url={asset.url} />
            <a
              href={asset.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-brand underline underline-offset-2"
            >
              Open
            </a>
          </div>

          <div className="mt-6">
            <AltTextForm id={asset.id} alt={asset.alt} />
          </div>
        </div>

        <div className="space-y-6">
          <Section title="File">
            <dl className="divide-y divide-line border-y border-line text-sm">
              <Row label="Type" value={asset.mime} mono />
              <Row
                label="Dimensions"
                value={asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—'}
              />
              <Row label="Size" value={formatBytes(asset.size)} />
              <Row label="SHA-256" value={`${asset.sha256.slice(0, 16)}…`} mono />
              <Row label="Stored" value={formatDate(asset.createdAt, context)} />
            </dl>
          </Section>

          {asset.thumbnail ? (
            <Section
              title="Thumbnail"
              description="A scaled copy written for the asset grid. Not for documents: a document's images are laid out wider than this, and a 480px file stretched to fit is blurry."
            >
              <div className="flex items-start gap-3 py-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.thumbnail.url}
                  alt=""
                  decoding="async"
                  className="h-16 w-auto border border-line bg-sunken object-contain"
                />
                <dl className="min-w-0 space-y-1 text-sm">
                  <div className="flex gap-2">
                    <dt className="text-ink-muted">Dimensions</dt>
                    <dd className="tabular-nums text-ink">
                      {asset.thumbnail.width} × {asset.thumbnail.height}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-ink-muted">Size</dt>
                    <dd className="tabular-nums text-ink">{formatBytes(asset.thumbnail.size)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-ink-muted">Stored at</dt>
                    <dd className="break-all font-mono text-xs text-ink-muted">
                      {asset.thumbnail.url}
                    </dd>
                  </div>
                </dl>
              </div>
            </Section>
          ) : null}

          {asset.variants.length > 0 ? (
            <Section
              title="Derivatives"
              description="Re-encodings written alongside the original. A page may point at one of these instead."
            >
              <ul className="divide-y divide-line border-y border-line text-sm">
                {asset.variants.map((variant) => (
                  <li key={variant.format} className="flex items-center justify-between gap-2 py-2">
                    <Badge variant="outline">{variant.format}</Badge>
                    <span className="tabular-nums text-ink-muted">{formatBytes(variant.size)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {asset.blurDataUrl ? (
            <Section title="Placeholder">
              <p className="text-xs leading-relaxed text-ink-muted">
                A {asset.blurDataUrl.length}-byte inline placeholder is stored, and is painted
                behind the image while it loads: the reader sees the composition rather than an
                empty box.
              </p>
            </Section>
          ) : null}
        </div>
      </div>

      <Section
        title="References"
        description="Checked in three places: image links in document bodies, cover and social images in frontmatter, and the site avatar."
      >
        {!inUse ? (
          <InlineNote>
            Nothing references this file. It is a candidate for deletion — the delete button checks
            again before it runs.
          </InlineNote>
        ) : (
          <>
            {usage?.usedAsSiteAvatar ? (
              <InlineNote tone="warning">
                This file is the site avatar, set in{' '}
                <Link href="/admin/settings" className="text-brand underline underline-offset-2">
                  Settings
                </Link>
                . Deleting it leaves the avatar broken.
              </InlineNote>
            ) : null}

            {documents.length > 0 ? (
              <div className="overflow-x-auto border-t border-line">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">Documents referencing this asset</caption>
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                        Document
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                        Status
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                        Referenced as
                      </th>
                      <th scope="col" className="py-2 text-right font-medium text-ink-muted">
                        <span className="sr-only">Edit</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((document) => (
                      <tr key={`${document.id}-${document.via}`} className="border-b border-line last:border-0">
                        <th scope="row" className="py-2 pr-3 text-left font-normal text-ink">
                          {document.title}
                        </th>
                        <td className="py-2 pr-3">
                          <StatusBadge status={document.status} />
                        </td>
                        <td className="py-2 pr-3 text-ink-muted">
                          {document.via === 'link'
                            ? 'a link in the body'
                            : document.via === 'cover'
                              ? 'the cover image'
                              : 'the social image'}
                        </td>
                        <td className="py-2 text-right">
                          <Link
                            href={`/admin/${segmentForType(document.type)}/${document.slug}/edit`}
                            className="text-xs text-brand underline underline-offset-2"
                          >
                            Edit
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </Section>
    </Page>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-ink' : 'text-ink'}>{value}</dd>
    </div>
  )
}

