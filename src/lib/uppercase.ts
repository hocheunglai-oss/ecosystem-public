// Preserve addresses and links inside otherwise uppercase prose. URL paths,
// queries, and mailbox local parts can be case-sensitive.
// Start boundaries avoid repeatedly scanning a long unbroken pasted value.
const preservedText = /(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/[^\s<>"']+|\b(?:mailto|tel):[^\s<>"']+|\bwww\.[^\s<>"']+|(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?(?::\d+)?|(?<![\p{L}\p{N}.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d+)?[/?#][^\s<>"']*/giu

type TextPart = { text: string; preserve: boolean }

/** Presentation-only detection for cells containing just an email address. */
export function isEmailText(text: string): boolean {
  return /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?$/u.test(text.trim())
}

function parts(text: string): TextPart[] {
  const result: TextPart[] = []
  let cursor = 0
  for (const match of text.matchAll(preservedText)) {
    const index = match.index!
    if (index > cursor) result.push({ text: text.slice(cursor, index), preserve: false })
    result.push({ text: match[0], preserve: true })
    cursor = index + match[0].length
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor), preserve: false })
  return result
}

export function uppercaseText(text: string): string {
  return parts(text).map(part => part.preserve ? part.text : part.text.toUpperCase()).join('')
}

// Selection offsets use UTF-16 code units, as do browser input selections.
// Calculate against the complete text so a caret within an email or URL does
// not mistakenly cause a partial address to be treated as ordinary prose.
export function uppercaseSelectionOffset(text: string, offset: number): number {
  let remaining = Math.max(0, Math.min(text.length, offset))
  let result = 0
  for (const part of parts(text)) {
    const prefix = part.text.slice(0, remaining)
    result += part.preserve ? prefix.length : prefix.toUpperCase().length
    remaining -= prefix.length
    if (!remaining) break
  }
  return result
}
