// Orca: mobile/src/terminal/terminal-text-field-submit-binding.web.ts @ de8bffe24045b396212f4f63de8960ec8380ea07
// MIT Copyright (c) 2026 Lovecast Inc. Adaptation: DOM field type. See ../LICENSE.orca.
type TextInput = HTMLTextAreaElement | HTMLInputElement

/**
 * Claim the page's own submit signal for the live input, because react-native-web withholds
 * `onSubmitEditing` whenever the Enter keydown reports an open composition (`isComposing`, or the
 * Android `keyCode` 229 that stands for it) — the normal state of a soft keyboard mid-word.
 *
 * `beforeinput`/`insertLineBreak` is the browser saying the user asked to end the line, and it is
 * dispatched only when nothing cancelled the keydown. react-native-web calls `preventDefault` on
 * every keydown it does submit on, so this fires in exactly the cases it dropped, never twice. A
 * composing IME that is still choosing a candidate produces `insertCompositionText` instead and is
 * left alone, which is how an interrupted composition survives here as it does natively.
 */
export function bindTerminalTextFieldSubmit(
  node: TextInput | null,
  onSubmit: () => void
): () => void {
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement)) {
    return () => {}
  }
  const field = node
  const submitOnLineBreak = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    if (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph') {
      return
    }
    event.preventDefault()
    onSubmit()
  }
  field.addEventListener('beforeinput', submitOnLineBreak)
  return () => field.removeEventListener('beforeinput', submitOnLineBreak)
}
