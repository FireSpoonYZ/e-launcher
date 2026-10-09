// Orca: mobile/src/terminal/document/write-queue.ts @ de8bffe24045b396212f4f63de8960ec8380ea07
// MIT Copyright (c) 2026 Lovecast Inc. Adaptation: presentation normalizer only. See ../LICENSE.orca.
/** Claude's record dot, which iOS WebKit would otherwise promote to a colourful emoji glyph. */
const CLAUDE_STATUS_DOT = '\u23fa'

/** The variation selector that forces the text glyph. */
const TEXT_PRESENTATION_SELECTOR = '\ufe0e'

/** The variation selector that forces the emoji glyph. */
const EMOJI_PRESENTATION_SELECTOR = '\ufe0f'

/**
 * The dot with any trailing selectors, as one pattern.
 *
 * A literal rather than a construction: a `new RegExp` at a module's top level is parse-time work
 * (ruling 20), and `replace` leaves no `lastIndex` behind for the next document to find.
 */
const CLAUDE_STATUS_DOT_PATTERN = /\u23fa[\ufe0e\ufe0f]*/g

export function isStatusDotPresentationSelector(value: string) {
  return value === TEXT_PRESENTATION_SELECTOR || value === EMOJI_PRESENTATION_SELECTOR
}

export function endsWithStatusDotPresentationSequence(data: string) {
  let i = data.length - 1
  while (i >= 0 && isStatusDotPresentationSelector(data.charAt(i))) {
    i--
  }
  return i >= 0 && data.charAt(i) === CLAUDE_STATUS_DOT
}

// Why: iOS WebKit promotes Claude's record/status dot to a colorful emoji glyph.
export function normalizeStatusDotPresentation(scope: { statusDotPendingSelector: boolean }, data: string) {
  if (typeof data !== 'string' || data.length === 0) {
    return data
  }
  if (scope.statusDotPendingSelector) {
    scope.statusDotPendingSelector = false
    let strippedPendingSelectors = false
    while (data.length > 0 && isStatusDotPresentationSelector(data.charAt(0))) {
      data = data.slice(1)
    }
    strippedPendingSelectors = data.length === 0
    if (strippedPendingSelectors) {
      scope.statusDotPendingSelector = true
      return ''
    }
  }
  const normalized = data.replace(
    CLAUDE_STATUS_DOT_PATTERN,
    CLAUDE_STATUS_DOT + TEXT_PRESENTATION_SELECTOR
  )
  scope.statusDotPendingSelector = endsWithStatusDotPresentationSequence(data)
  return normalized
}
