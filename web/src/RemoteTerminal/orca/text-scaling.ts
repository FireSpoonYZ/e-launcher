// Orca: mobile/src/terminal/document/text-scaling.ts @ de8bffe24045b396212f4f63de8960ec8380ea07
// MIT Copyright (c) 2026 Lovecast Inc. Pure scale/font functions only. See ../LICENSE.orca.
import { TERMINAL_TEXT_SCALES } from './terminal-text-scales.ts'
const BASE_FONT_PX = 13
const MIN_FONT_PX = 6

const TEXT_SCALE_PRESETS: readonly number[] = TERMINAL_TEXT_SCALES

/** The ends of the preset range, which a pinch is clamped to. */
export const MIN_TEXT_SCALE = TEXT_SCALE_PRESETS[0]
export const MAX_TEXT_SCALE = TEXT_SCALE_PRESETS[TEXT_SCALE_PRESETS.length - 1]

export function snapToTextScalePreset(value: number) {
  let best = TEXT_SCALE_PRESETS[0],
    bestDelta = Infinity
  for (let i = 0; i < TEXT_SCALE_PRESETS.length; i++) {
    const delta = Math.abs(TEXT_SCALE_PRESETS[i] - value)
    if (delta < bestDelta) {
      bestDelta = delta
      best = TEXT_SCALE_PRESETS[i]
    }
  }
  return best
}
export function fontPxForScale(scale: number) {
  return Math.max(MIN_FONT_PX, Math.round(BASE_FONT_PX * scale))
}
export function isIOSWebView() {
  if (/iP(ad|hone|od)/.test(navigator.userAgent)) {
    return true
  }
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
// Why: iOS WebKit does not reliably resolve "SF Mono" by CSS family name and can
// fall to a non-monospace face; lead with the ui-monospace generic to avoid that.
const TERMINAL_FONT_FALLBACKS =
  '"Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", monospace'


export function terminalFontFamily() { return (isIOSWebView() ? 'ui-monospace, ' : '"SF Mono", ') + TERMINAL_FONT_FALLBACKS }
