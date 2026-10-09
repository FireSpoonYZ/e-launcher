# Remote terminal source attribution and adaptations

Orca reference is read-only: `D:/project/.agent-work/e-terminal/orca-reference`, commit
`de8bffe24045b396212f4f63de8960ec8380ea07`.
MIT, Copyright (c) 2026 Lovecast Inc. Full notice: [LICENSE.orca](LICENSE.orca).
Every copied module carries its original path and commit.

## Reused Orca source

| Local file | Original path | Adaptation |
| --- | --- | --- |
| orca/terminal-accessory-keys.ts | mobile/src/terminal/terminal-accessory-keys.ts | Local .ts imports |
| orca/terminal-key-definitions.ts | mobile/src/terminal/terminal-key-definitions.ts | Local .ts type import |
| orca/terminal-accessory-repeat.ts | mobile/src/terminal/terminal-accessory-repeat.ts | Unchanged controller/sender |
| orca/terminal-live-input.ts | mobile/src/terminal/terminal-live-input.ts | Local .ts import; original helper retained, wire-specific 64 KiB guard now in input.ts |
| orca/terminal-live-preedit-mirror.ts | mobile/src/terminal/terminal-live-preedit-mirror.ts | Unchanged mirror; DOM reports composition explicitly |
| orca/terminal-text-field-submit-binding.web.ts | mobile/src/terminal/terminal-text-field-submit-binding.web.ts | RN TextInput type replaced with DOM textarea/input |
| orca/terminal-gesture-input.ts | mobile/src/terminal/terminal-gesture-input.ts | Unchanged bounded gesture validation |
| orca/terminal-unicode-provider.ts | src/shared/terminal-unicode-provider.ts | Unicode11 ZWJ logic unchanged; explicit constructor field for Node strip-only tests |
| orca/terminal-accessory-layout.ts | mobile/src/terminal/terminal-accessory-layout.ts | Pure v1/v2 normalization, order/visibility/migration; no AsyncStorage or mirrored storage imports |
| orca/terminal-text-scales.ts | mobile/src/terminal/terminal-text-scales.ts | Unchanged preset values |
| orca/text-scaling.ts | mobile/src/terminal/document/text-scaling.ts | Pure font/nearest-preset/iOS-family functions only |
| orca/terminal-grid-fit.ts | mobile/src/terminal/terminal-grid-fit.ts | Unchanged min20x8/tolerance formula |
| orca/status-dot.ts | mobile/src/terminal/document/write-queue.ts | Split-chunk FE0E normalization only; narrow pending-selector scope |
| orca/theme.ts | mobile/src/terminal/terminal-webview-html/theme.ts | Inline terminalBg #1a1b26 from mobile/src/theme/mobile-theme.ts; xterm type |
| viewport.ts | mobile/src/terminal/document/viewport-transform.ts + fit-scale.ts | Cell-box CSS fit (>=.95 snaps to 1), hidden-frame hold and bounded retry in DOM caller; no local parser resize |
| selection.ts + surface.ts | mobile/src/terminal/document/selection-range.ts, selection-state-and-eviction.ts, selection-overlay.ts, tap-dispatch.ts, surface-touch-gestures.ts | DOM controller replaces document/RN scope: 500ms/10px long press, absolute cell coordinates, wide-cell word seeding, direct handles/Copy/edge scroll, actual buffer trim events, transient pinch with preset commit |
| orca/keyboard-avoidance-metrics.ts | mobile/src/terminal/document/keyboard-avoidance-metrics.ts + mobile/src/terminal/terminal-keyboard-avoidance-lift.ts | Public xterm buffer content/cursor anchor and drawn row margin; Capacitor already resizes the frame, so a bounded local grid translation replaces RN keyboard pane lift |
| input.ts encodePaste | mobile/src/session/use-mobile-terminal-paste.ts buildMobileTerminalClipboardTextPayload | Literal text paste, no alt-screen wrapping, strip embedded 200/201 markers when wrapped; launcher keeps 64KiB boundary |
| orca/terminal-mouse-encoding.ts | src/shared/terminal-mouse-encoding.ts | Unchanged xterm mode reading |
| orca/terminal-kitty-keyboard-flags.ts | src/shared/terminal-kitty-keyboard-flags.ts | Unchanged flag boundary validation |
| gestures.ts | mobile/src/terminal/document/mouse-input-encoding.ts | Original encoding/routing functions; narrow DOM rectangle/callback adapter replaces RN document scope, transform graph and notify |
| presets.ts | src/shared/terminal-quick-commands.ts | Retains bounded normalization and upsert/delete pattern; no repo/agent launch dependency. Adds generic chord records, order-by-array, device-local persistence. Invalid saved records fail visibly; Enter is explicit, not defaulted |

## Follow-up input corrections

Also reused `src/renderer/src/components/terminal-pane/terminal-ime-kitty-commit-encoding.ts`
and its pure `terminal-kitty-csi-u-encoding.ts` dependency from the same Orca commit,
under `orca/` with local import adaptations only. Soft-keyboard/IME live text
commits use this commit encoder with literal codepoints, rather than a lowercasing physical-key
encoder. DOM hardware events retain `code` (shifted base keys and keypad), and event-reporting
mode tracks printable presses even without report-all. Releases use the actual keyup modifiers.

Per-request text input is limited to 64 KiB UTF-8 **after** encoding, including bracketed-paste
and Kitty overhead. Oversized local input leaves ownership and the draft/mirror unchanged.
Queue accounting also uses UTF-8 bytes. Native binary/byte validation is handled separately by
parent; this mobile delta does not add binary sending.

Only the terminal screen/canvas uses Orca's Tokyo terminal palette. Headers, dialogs, other app
routes and chat fonts retain e-launcher's styling. Font defaults are mobile Orca: 13px at scale 1,
300/500 weight, bar/non-blinking caret with immediately visible inactive block. Exited sessions can be removed
through the same explicit close endpoint.

## xterm

Exact dependencies: `@xterm/xterm 6.1.0-beta.303`,
`@xterm/addon-unicode11 0.10.0-beta.300`,
`@xterm/addon-fit 0.12.0-beta.300` remains installed but is no longer used to resize the client,
`@xterm/addon-webgl 0.20.0-beta.299` (same versions as Orca).

The official MIT WebGL addon is loaded after `term.open`, with its default custom
Powerline/box-drawing glyph rasterization enabled; no font or xterm patches are added.
`renderer.ts` follows the bounded fallback pattern in Orca's
`mobile/src/terminal/document/webgl-recovery.ts` and the post-open attachment in
`terminal-init.ts` at the pinned revision above: failed initialization keeps DOM,
context loss disposes the addon to restore DOM, and only one 100 ms retry is allowed.
Foreground visibility and Capacitor resume reapply the terminal theme, clear the active texture
atlas and refresh every row. View cleanup removes visibility/loss listeners and cancels that timer
before terminal disposal.
The existing Orca Unicode provider and input protocol boundary remain unchanged.

`xterm/KittyKeyboard.ts` is lifted from the installed exact
`@xterm/xterm/src/common/input/KittyKeyboard.ts`, not a newly invented encoder.
Its imports point to the extracted minimal `xterm/types.ts` from
`src/common/Types.ts`; TypeScript enums become equivalent const objects so Node's
native TS test runner can execute the adapter without a new test framework.
Original MIT headers remain; full license: [xterm/LICENSE](xterm/LICENSE).
The xterm encoder handles negotiated Kitty flags, physical press/repeat/release and modifiers;
committed Unicode text uses the Orca IME encoder described above. Non-Kitty accessory bytes reuse Orca; modified Enter is explicitly CSI 13;modifier u.

## Input and protocol boundaries

Supervisor approved the independent DOM textarea instead of copying Orca's 7.4 MB generated
CompositionHelper patch: xterm stdin is disabled and its hidden textarea is hidden. Hardware,
soft keyboard, composition, repeat and presets all enter the explicit adapter. There is no
`onData`/`onBinary` PTY bridge, so replay/live parser-generated DA/CPR responses die locally.
Only the host answers terminal queries. The xterm client parses raw ANSI without stripping;
Unicode provider and snapshot Kitty flags are restored before ownership enables input.

Only a host snapshot changes client cols/rows. Observers scale the authoritative grid locally;
phone refits request terminal.displayModeSet(auto, viewport), while desktop font/keyboard changes
never resize the PTY. A width-fitted grid taller than its frame is locally lifted to the normal-buffer cursor/content-bottom anchor (including colored footers), or the alternate-buffer bottom. Two-finger vertical pan and explicit earlier/later-row/reveal controls provide bounded access to all screen rows without stealing single-finger PTY mouse/scroll gestures. Selection geometry reads the transformed screen rectangle; edge dragging pans the clipped screen before scrolling history. Manual inspection survives ordinary output; frame changes recompute anchor lift, without height-based font shrinking. The supervisor-approved e-desktop host retains/restores the desktop baseline.
The actual response contract is {session,snapshot} with session.displayMode=auto|phone|desktop;
snapshot events carry displayMode alongside snapshot (not inside it). Missing metadata visibly
requires a host update. The serialized viewport queue retires stale auto refits after explicit
desktop selection, and only current subscription/owner epochs can dispatch.
Touch scrolling/click encoding reuses Orca; long press selects the live buffer directly with
draggable endpoints and Copy/Select all/Done tools; the menu copy surface is only an alternative. SGR is used when negotiated. Legacy X10 reports retain Orca's ASCII coordinate
bounds; out-of-range legacy wheel coordinates fall back to bounded arrow input, while an
out-of-range legacy tap produces no mouse report. This is not full legacy mouse coverage.
The optional wire extension terminal.send encoding:'binary' is not needed by this bounded
adapter. The generic native request wrapper can forward it without an API change; ordinary
text and SGR sends remain unchanged. Images are not advertised/supported in this text-only client.

No daemon/Electron/RN runtime graph, Pi-specific injection, generated engine or WebGL/image patches
were imported; WebGL rendering uses the official addon dependency, not Orca's patched runtime. Presets are local to this launcher installation, separate from chat data.
No authentication token crosses the JS API. Native additions reuse RemoteTerminalPlugin/MainActivity:
page-token-scoped textZoom=100 (latest system fontScale restored on exit; stale cleanup ignored),
explicit bounded text clipboard read/write, and validated display-mode RPC parameters.
MainActivity handles fontScale changes without replacing the WebView, while nonterminal routes
continue to receive system text zoom. xterm opens only after the native zoom call succeeds.
Per-handle DOM draft leases retain independent live and buffered composers across tabs. Mode changes
send nothing and erase no remote text; only an acknowledged live prefix can be retired locally.
Queued/in-flight/IME/unknown or unconfirmed live edits block switching rather than discarding text.
Paste (including DOM paste) goes directly to the PTY in both modes: it waits for admitted live deltas
to settle, rechecks owner/session epochs, and never submits or modifies a buffered draft. Text macros
also leave a buffered draft alone; only Enter submits it. External delivery ambiguity is visible and
never automatically retried. Field-owned in-flight delivery is tracked separately, so leaving during
an external Paste cannot quarantine a buffered command that was never submitted.
Explicit empty buffered editing resets only that composer's unknown/rejected state locally, sending no PTY bytes; nonempty unknown commands remain quarantined.
Queued boundary cancellation restores the draft before cleanup saves it. In-flight field navigation
is conservatively quarantined rather than resent. No process-restart draft persistence is claimed.
Text scale and built-in layout use separate localStorage keys, never rewriting custom preset data.

## Validation boundary

Node behavior checks and TypeScript/Vite build are not evidence of Android WebView IME or touch
fidelity. Parent must test real Chinese IME candidate acceptance and soft Enter/backspace,
hardware keyboard, keyboard-hide/reopen, long-press repeat cancellation, selection/copy,
TUI mouse gestures, owner takeover, foreground resubscribe and host/client snapshot parity.
Private xterm Kitty/mouse/Unicode seams are pinned to the exact dependency versions above.

## Scrollable shortcut dock and combination editor

Layout and interaction reference: Orca mobile/src/session/MobileSessionCommandDock.tsx,
mobile/src/components/CustomKeyModal.tsx and TerminalShortcutSettings.tsx at the same
pinned revision above (MIT, Copyright 2026 Lovecast Inc.). The DOM implementation
uses the existing e-launcher palette, local preset schema and terminal encodeKey path. Android preset persistence uses an original, separate committed SharedPreferences adapter; browser preview uses localStorage.
Unlike immediate press-in dispatch, accessory-press.ts waits for a stationary hold
or release and cancels on movement, so scrolling cannot send its starting key.
No new React Native code, network transport or dependency is included.
