# Pi runtime for Android

Android Pi mode uses the full `@earendil-works/pi-coding-agent` SDK, pinned to **0.85.1**, with matching Pi core/AI packages. `sdk.js` owns session creation, native model/resource loading, tools, thinking levels, compaction, retries, credentials and package operations. The smaller `createPiRuntime` adapter in `index.js` remains for compatibility and regression checks.

The independent [`@e-launcher/pi-phone-control`](extensions/phone-control/README.md) extension owns `shower`, `list_apps` and `search_apps`. Android loads it through Pi's native extension loader as the named bundled extension `phone-control`; `sdk.js` only accepts generic resource-loader options and no longer registers phone tools through `customTools`. Each operation supplies native callbacks through its own loader event bus, preserving conversation isolation. The extension is included in the Android bundle and can also be packaged separately with `npm pack`.

The `shower` tool is a direct native bridge to the app's Operit Shower controller, not MCP or loopback HTTP. Node sends request-ID/call-ID tagged operations over the existing same-UID/same-PID local socket; Java validates and serializes them onto the single virtual display. Responses carry real errors, and cancellation or the 20-second timeout sends a native cancel without replay. Screenshots return PNG image content plus both virtual-display and scaled-image dimensions. An explicit `release` owns cleanup across Pi turns.

## Configuration and sessions

The Java host supplies app-private global/workspace settings, models, credentials, system prompts and resource paths. The runtime does not load the user's desktop Pi directory. Forms and file editing share those files; the next request reads a fresh snapshot. Current-chat model/thinking selection is separate from startup defaults. CLI/TUI-only settings do not control Android rendering or permissions.

Requests use the SDK model's supported thinking levels. Session snapshots include the native header and entries, preserving compaction cut points; restoring a branch can append messages after its nearest snapshot. Context is emitted in `finally`, including when a prompt throws. Android persists terminal events independently of Activity lifetime. Pending-turn checks prevent a late UI preview from replacing final text or reviving a deleted conversation. A missing known native snapshot is reported instead of silently replaying text.

Models, resource diagnostics, OAuth prompts, credential updates, package operations and resource toggles use the SDK. Provider credentials are updated through the host's conflict-checked file store. The APK includes official npm **11.6.2** and an executable launcher linked to the existing Node Mobile library. npm sources use this bundled command by default; a custom `npmCommand` takes precedence. Git sources still require Git; local packages use app-accessible paths. Configured package paths are not proof that an extension loaded successfully.

Android supplies a thin, non-TUI extension UI context. The first version displays text/factory widgets, status and notifications; dialogs return cancellation and terminal/custom-editor APIs remain unavailable. A normally installed, unmodified `@juicesharp/rpiv-todo` package is recognized from its loaded package metadata and shown as a native web progress strip. Todo recovery reads only structured tool-result snapshots, never rendered ANSI text.

## Bridge and packaging

The app starts Node once with private `HOME`/`TMPDIR` and exchanges request-ID-tagged newline JSON over a randomized abstract Unix socket. The connecting peer must match the app process UID and PID. One operation per conversation is admitted at a time; independent conversations may run concurrently. The protocol includes busy rejection, cancellation, errors, OAuth replies and call-ID-tagged Shower requests. Startup failure is sticky until process restart.

`scripts/prepare-pi-runtime.ps1` prepares Node Mobile 24.18.0-0, arm64 libraries/headers and npm dependencies. `npm run build:android` bundles `android.js` into `app/src/main/assets/pi-runtime.cjs` and copies the pinned SDK metadata, documentation, themes and export resources into `app/src/main/assets/pi-sdk/`. The build also copies the complete pinned npm distribution to `assets/npm/11.6.2/`. These outputs are generated and ignored by Git. Gradle packages the Node executable as `libnode_launcher.so`, with native-library extraction enabled so Android can execute it from `nativeLibraryDir`. The app prepares npm in a versioned private directory and repairs its `node` symlink after APK replacement. The bundle maps `import.meta.url`, sets `PI_PACKAGE_DIR`, and uses the pinned SDK's internal HTTP dispatcher bootstrap.

## Local verification

```sh
npm --prefix pi-runtime ci
npm --prefix pi-runtime test
```

The suite checks all 65 documented settings keys, wire-level thinking values, scoped resources, local package lifecycle, native history/compaction, session-only selection, cancellation and context publication after a throwing prompt. It also checks the Shower tool schema boundary, native dispatch, screenshot image projection, errors and cancellation, then builds and executes the shipped CJS bridge with a simulated Java Shower response plus local mock SSE, TypeScript extensions/tools/providers, simulated OAuth and busy/abort/recovery checks. Mock native/provider replies are not device or provider validation.

The npm integration check uses a loopback npm registry and mock model to exercise the shipped bundle: scoped/versioned package installation, dependencies and `postinstall`, `node` and `process.execPath`, persisted settings, fresh TypeScript extension loading, same-chat next-turn tool execution, filtering, workspace precedence, ordinary npm packages, load errors, repeated installation and removal. It makes no real model requests.

Run `scripts/verify.ps1` after the runtime suite for JVM tests, pure Java checks, APK assembly and lint. Build `:app:assembleDebugAndroidTest`, install the app and test APKs with `adb -s <serial> install -r`, then run:

```sh
adb -s <serial> shell am instrument -w -e checks npm com.example.launcherprobe.test/com.example.launcherprobe.ChatStoreChecks
```

This runs the same npm integration script from the target application's UID, using isolated files/cache directories. It also checks npm resource reuse and dangling launcher-link repair. It never reads real credentials or modifies chat settings. Passing desktop Node/JVM checks alone does not establish Android execution, real OAuth, native-addon or arbitrary extension compatibility.
