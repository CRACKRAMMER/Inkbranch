/**
 * Safari fallback for `<dialog closedby="any">`.
 * When `closedBy` is natively supported, browsers handle light dismiss natively.
 * Otherwise, only dismiss when both pointerdown and pointerup/click originate
 * directly on the dialog backdrop outside its visible content box.
 */
export function attachClosedByFallback(
  dialog: HTMLDialogElement,
  onClose?: () => void,
): () => void {
  if ('closedBy' in HTMLDialogElement.prototype) {
    return () => {}
  }

  let pointerDownOutside = false

  const isOutsideRect = (e: PointerEvent | MouseEvent) => {
    const rect = dialog.getBoundingClientRect()
    return (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    )
  }

  const onPointerDown = (e: PointerEvent) => {
    pointerDownOutside = e.target === dialog && isOutsideRect(e)
  }

  const onClick = (e: MouseEvent) => {
    if (pointerDownOutside && e.target === dialog && isOutsideRect(e)) {
      dialog.close()
      onClose?.()
    }
    pointerDownOutside = false
  }

  dialog.addEventListener('pointerdown', onPointerDown)
  dialog.addEventListener('click', onClick)
  return () => {
    dialog.removeEventListener('pointerdown', onPointerDown)
    dialog.removeEventListener('click', onClick)
  }
}
