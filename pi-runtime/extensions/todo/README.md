# e-launcher bundled todo

Adapted from `@juicesharp/rpiv-todo` **2.12.0**, Copyright (c) 2026 juicesharp.
Upstream: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo.
License: [MIT](LICENSE). This fork is embedded in e-launcher, not published to npm.

`sdk.js` registers it as the replaceable `builtin:todo` extension. Remove the
old npm todo package before using it. Tool actions and fields remain compatible:
create, update, list, get, delete and clear; descriptions, activeForm, dependencies,
owner and metadata. Android supplies the UI, so terminal overlays, slash commands,
hotkeys and rpiv configuration/i18n dependencies are omitted.

Mutations synchronously append a complete `e-launcher-todo` custom snapshot to
the native session before committing live state. Reads and rejected/no-op updates
do not append state. Restore scans the active branch, taking the last valid custom
snapshot, or the last valid old todo tool-result snapshot when no custom snapshot
exists. Custom entries remain outside model context and survive compaction.
The host persists all session entries using its existing private history files.
Factory-local state isolates concurrent runtimes; no cwd-level todo file is used.

Run `node pi-runtime/todo-check.js` for reducer/lifecycle checks and real SDK
codemode cross-turn/isolation/migration checks. The standard runtime test suite
also exercises the built APK JavaScript payload through `check-bridge.js`.
