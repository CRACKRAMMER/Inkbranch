'use client'

import { toast } from 'sonner'

import { restoreRevisionAction } from '@/app/admin/actions/revisions'
import { ConfirmAction } from './confirm-action'

/**
 * Put a revision back into the file.
 *
 * The dialog says what a restore replaces before it does it, and the toast after
 * it says whether the state it replaced was recorded — because that one boolean
 * is the difference between a restore you can undo and one you cannot, and a UI
 * that stays silent about it lets someone believe they have an undo they do not
 * have.
 *
 * No navigation afterwards: the page the button is on already shows the
 * document's history, and `ConfirmAction` refreshes it, so the new "Before
 * restore" row appears where the reader is looking.
 */
export function RestoreRevisionButton({
  revisionId,
  revisionNo,
  createdAt,
  additions,
  deletions,
  variant = 'default',
  label,
}: {
  revisionId: string
  revisionNo: number
  createdAt: string
  additions: number
  deletions: number
  variant?: 'default' | 'secondary' | 'outline'
  label?: string
}) {
  return (
    <ConfirmAction
      action={restoreRevisionAction}
      payload={{ revisionId }}
      triggerLabel={label ?? `Restore revision #${revisionNo}`}
      triggerVariant={variant}
      destructive={false}
      title={`Restore revision #${revisionNo}?`}
      description={
        <>
          <p>
            This writes revision #{revisionNo} ({createdAt}, +{additions}/−{deletions}) back into the
            Markdown file and updates the content index.
          </p>
          <p className="mt-2">
            Whatever is in the file now is replaced. The current contents are recorded as a new
            revision first, so the restore is undoable.
          </p>
        </>
      }
      confirmLabel="Restore"
      onSuccess={(data) => {
        const result = data as {
          restoredRevisionNo: number
          undoRevisionNo: number | null
        }
        toast.success(`Revision #${result.restoredRevisionNo} restored to the file.`, {
          description:
            result.undoRevisionNo !== null
              ? `The state it replaced was recorded as revision #${result.undoRevisionNo}, so this can be undone.`
              : 'The state it replaced could not be recorded — only git or a backup can bring it back.',
        })
      }}
    />
  )
}
