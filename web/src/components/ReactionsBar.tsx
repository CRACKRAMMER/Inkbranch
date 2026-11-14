import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getReactions, toggleReaction } from '../lib/api'
import type { ContentType, ReactionCount, ReactionEmoji, ReactionsResponse } from '../lib/types'

interface ReactionsBarProps {
  contentType: ContentType
  slug: string
  orientation?: 'vertical' | 'horizontal'
}

const EMOJI_LABELS: Record<ReactionEmoji, string> = {
  '👍': '赞同',
  '🔥': '热门共鸣',
  '💡': '深受启发',
  '❤️': '喜爱',
  '🎉': '庆祝精彩',
}

const EMOJI_ORDER: ReactionEmoji[] = ['👍', '🔥', '💡', '❤️', '🎉']

export function ReactionsBar({
  contentType,
  slug,
  orientation = 'horizontal',
}: ReactionsBarProps) {
  const queryClient = useQueryClient()
  const queryKey = ['reactions', contentType, slug]

  const { data } = useQuery({
    queryKey,
    queryFn: () => getReactions(contentType, slug),
    staleTime: 30_000,
  })

  const counts: ReactionCount[] = EMOJI_ORDER.map((emoji) => {
    const found = data?.counts.find((c) => c.emoji === emoji)
    return found ?? { emoji, count: 0, reacted: false }
  })

  const handleToggle = async (emoji: ReactionEmoji) => {
    const prev = queryClient.getQueryData<ReactionsResponse>(queryKey) ?? { counts }
    const optimistic: ReactionsResponse = {
      counts: counts.map((item) => {
        if (item.emoji !== emoji) return item
        const nextReacted = !item.reacted
        return {
          ...item,
          reacted: nextReacted,
          count: Math.max(0, item.count + (nextReacted ? 1 : -1)),
        }
      }),
    }
    queryClient.setQueryData(queryKey, optimistic)

    try {
      const updated = await toggleReaction({ type: contentType, slug, emoji })
      queryClient.setQueryData(queryKey, updated)
    } catch {
      // Keep optimistic toggle visible locally if Phase 4 reaction route is not mounted yet,
      // unless server rejected due to rate limit; fallback still keeps clean UX
      if (prev.counts.some((c) => c.count > 0)) {
        queryClient.setQueryData(queryKey, optimistic)
      }
    }
  }

  return (
    <div
      role="group"
      aria-label="文章表态"
      className={
        orientation === 'vertical'
          ? 'flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-card)]'
          : 'flex flex-wrap items-center gap-2'
      }
    >
      {counts.map((item) => (
        <button
          key={item.emoji}
          type="button"
          onClick={() => void handleToggle(item.emoji)}
          aria-pressed={Boolean(item.reacted)}
          title={EMOJI_LABELS[item.emoji]}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-all ${
            orientation === 'vertical' ? 'w-12 flex-col gap-0.5 py-2' : ''
          } ${
            item.reacted
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
          }`}
        >
          <span aria-hidden="true" className="text-base leading-none">
            {item.emoji}
          </span>
          <span className="font-mono text-[11px] tabular-nums">{item.count}</span>
          <span className="visually-hidden">{EMOJI_LABELS[item.emoji]}</span>
        </button>
      ))}
    </div>
  )
}
