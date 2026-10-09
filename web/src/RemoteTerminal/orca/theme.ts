// Orca: mobile/src/terminal/terminal-webview-html/theme.ts @ de8bffe24045b396212f4f63de8960ec8380ea07
// MIT Copyright (c) 2026 Lovecast Inc. Adaptation: inline mobile-theme terminalBg, xterm type. See ../LICENSE.orca.
import type { ITheme } from '@xterm/xterm'
export const DEFAULT_TERMINAL_THEME: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  selectionForeground: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5'
}

export const MOBILE_TERMINAL_CARET_OPTIONS = {
  cursorBlink: false,
  cursorStyle: 'bar',
  showCursorImmediately: true,
  cursorInactiveStyle: 'block'
} as const
