import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getPreview } from '../lib/api'
import { ArticleWorkbench } from './ArticlePage'
import { NotFoundPage } from './NotFoundPage'

export function PreviewPage({ token }: { token: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['preview', token],
    queryFn: () => getPreview(token),
    retry: false,
  })

  useEffect(() => {
    document.title = data?.document?.title
      ? `[预览] ${data.document.title} — Inkbranch`
      : '私密草稿预览 — Inkbranch'
  }, [data])

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[70ch] space-y-4">
        <div className="editorial-card h-12 animate-pulse" />
        <div className="editorial-card h-80 animate-pulse" />
      </div>
    )
  }

  if (isError || !data) {
    return <NotFoundPage />
  }

  return (
    <ArticleWorkbench
      detail={{
        document: data.document,
        context: data.context ?? {
          localGraph: { nodes: [], edges: [] },
          backlinks: [],
          related: [],
          translations: [],
        },
      }}
      isPreview
      previewExpiresAt={data.expiresAt}
    />
  )
}
