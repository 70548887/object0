/** Keep native/editor find behavior when focus is already in an editable
 * surface or dialog. Never treat IME composition as an application shortcut. */
export function shouldIgnoreFileSearchShortcut(
  event: Pick<
    KeyboardEvent,
    "target" | "defaultPrevented" | "isComposing" | "keyCode"
  >,
) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
    return true;
  const element = event.target as Element | null;
  return (
    typeof element?.closest === "function" &&
    !!element.closest(
      'input,textarea,select,[contenteditable="true"],[role="dialog"],[role="alertdialog"]',
    )
  );
}
