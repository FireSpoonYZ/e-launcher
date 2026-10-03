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
| orca/terminal-unicode-provider.ts | src/shared/terminal-unicode-provider.ts | Unchanged Unicode11 ZWJ provider |
| orca/terminal-mouse-encoding.ts | src/shared/terminal-mouse-encoding.ts | Unchanged xterm mode reading |
| orca/terminal-kitty-keyboard-flags.ts | src/shared/terminal-kitty-keyboard-flags.ts | Unchanged flag boundary validation |
| gestures.ts | mobile/src/terminal/document/mouse-input-encoding.ts | Original encoding/routing functions; narrow DOM rectangle/callback adapter replaces RN document scope, transform graph and notify |
| presets.ts | src/shared/terminal-quick-commands.ts | Retains bounded normalization and upsert/delete pattern; no repo/agent launch dependency. Adds generic chord records, order-by-array, device-local persistence. Invalid saved records fail visibly; Enter is explicit, not defaulted |

## Follow-up input corrections

Also reused `src/renderer/src/components/terminal-pane/terminal-ime-kitty-commit-encoding.ts`
and its pure `terminal-kitty-csi-u-encoding.ts` dependency from the same Orca commit,
under `orca/` with local import adaptations only. Soft-keyboard/IME, paste and text-macro
commits use this commit encoder with literal codepoints, rather than a lowercasing physical-key
encoder. DOM hardware events retain `code` (shifted base keys and keypad), and event-reporting
mode tracks printable presses even without report-all. Releases use the actual keyup modifiers.

Per-request text input is limited to 64 KiB UTF-8 **after** encoding, including bracketed-paste
and Kitty overhead. Oversized local input leaves ownership and the draft/mirror unchanged.
Queue accounting also uses UTF-8 bytes. Native binary/byte validation is handled separately by
parent; this mobile delta does not add binary sending.

The full-height terminal host/viewport follows the application background, including space below
a short host-sized canvas; sizing and Fit behavior are unchanged. Exited sessions can be removed
through the same explicit close endpoint.

## xterm

Exact dependencies: `@xterm/xterm 6.1.0-beta.303`,
`@xterm/addon-unicode11 0.10.0-beta.300`,
`@xterm/addon-fit 0.12.0-beta.300` (same versions as Orca).

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

App viewport handling remains authoritative. Owner resize requests are debounced, observers
keep host dimensions, font scaling is local, and explicit Fit asks the host to resize.
Touch scrolling/click encoding reuses Orca; text selection also has an explicit selectable
copy surface. SGR is used when negotiated. Legacy X10 reports retain Orca's ASCII coordinate
bounds; out-of-range legacy wheel coordinates fall back to bounded arrow input, while an
out-of-range legacy tap produces no mouse report. This is not full legacy mouse coverage.
The optional wire extension terminal.send encoding:'binary' is not needed by this bounded
adapter. The generic native request wrapper can forward it without an API change; ordinary
text and SGR sends remain unchanged. Images are not advertised/supported in this text-only client.

No daemon/Electron/RN runtime graph, Pi-specific injection, WebGL/image patches or new native input
API was imported. Presets are local to this launcher installation, separate from chat data.
No authentication token crosses the JS API.

## Validation boundary

Node behavior checks and TypeScript/Vite build are not evidence of Android WebView IME or touch
fidelity. Parent must test real Chinese IME candidate acceptance and soft Enter/backspace,
hardware keyboard, keyboard-hide/reopen, long-press repeat cancellation, selection/copy,
TUI mouse gestures, owner takeover, foreground resubscribe and host/client snapshot parity.
Private xterm Kitty/mouse/Unicode seams are pinned to the exact dependency versions above.
