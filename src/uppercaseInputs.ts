import { uppercaseSelectionOffset, uppercaseText } from './lib/uppercase'

type TextControl = HTMLInputElement | HTMLTextAreaElement

export function installUppercaseInputs(root: Document = document): () => void {
  const view = root.defaultView
  if (!view) return () => {}
  const composing = new WeakSet<TextControl>()
  let active = true

  const controlFor = (target: EventTarget | null): TextControl | null => {
    if (!(target instanceof view.HTMLInputElement) && !(target instanceof view.HTMLTextAreaElement)) return null
    if (target.closest('[data-preserve-case]')) return null
    const autocomplete = (target.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/)
    if (autocomplete.some(token => ['email', 'current-password', 'new-password', 'one-time-code'].includes(token))) return null
    if (['email', 'url'].includes(target.inputMode)) return null
    if (target instanceof view.HTMLInputElement && !['text', 'search', 'tel'].includes(target.type)) return null
    return target
  }

  const normalize = (control: TextControl): boolean => {
    const original = control.value
    const next = uppercaseText(original)
    if (next === original) return false
    const start = control.selectionStart
    const end = control.selectionEnd
    const direction = control.selectionDirection
    const scrollTop = control.scrollTop
    const scrollLeft = control.scrollLeft
    const prototype = control instanceof view.HTMLTextAreaElement
      ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype
    // Bypass React's own value setter: its change tracker must see the same
    // difference it would have seen from an ordinary browser input event.
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, next)
    if (start !== null && end !== null) {
      control.setSelectionRange(
        uppercaseSelectionOffset(original, start),
        uppercaseSelectionOffset(original, end),
        direction || 'none',
      )
    }
    control.scrollTop = scrollTop
    control.scrollLeft = scrollLeft
    return true
  }

  const onInput = (event: Event) => {
    const control = controlFor(event.target)
    if (!control || composing.has(control) || (event instanceof view.InputEvent && event.isComposing)) return
    normalize(control)
  }
  const onCompositionStart = (event: Event) => {
    const control = controlFor(event.target)
    if (control) composing.add(control)
  }
  const onCompositionEnd = (event: Event) => {
    const control = controlFor(event.target)
    if (!control) return
    composing.delete(control)
    // Allow the browser's final composition input first. If it emits no final
    // input, finish normalization and notify controlled React fields ourselves.
    queueMicrotask(() => {
      if (!active || !control.isConnected || composing.has(control) || !controlFor(control)) return
      if (normalize(control)) control.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }))
    })
  }

  root.addEventListener('input', onInput, true)
  root.addEventListener('change', onInput, true)
  root.addEventListener('compositionstart', onCompositionStart, true)
  root.addEventListener('compositionend', onCompositionEnd, true)
  return () => {
    active = false
    root.removeEventListener('input', onInput, true)
    root.removeEventListener('change', onInput, true)
    root.removeEventListener('compositionstart', onCompositionStart, true)
    root.removeEventListener('compositionend', onCompositionEnd, true)
  }
}
