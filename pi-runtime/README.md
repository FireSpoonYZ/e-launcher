# Pi runtime for Android

Android Pi mode uses the full `@earendil-works/pi-coding-agent` SDK, pinned to **0.85.1**, with matching Pi core/AI packages. `sdk.js` owns session creation, native model/resource loading, tools, thinking levels, compaction, retries, credentials and package operations. The smaller `createPiRuntime` adapter in `index.js` remains for compatibility and regression checks.

## Configuration and sessions

The Java host supplies app-private global/workspace settings, models, credentials, system prompts and resource paths. The runtime does not load the user's desktop Pi directory. Forms and file editing share those files; the next request reads a fresh snapshot. Current-chat model/thinking selection is separate from startup defaults. CLI/TUI-only settings do not control Android rendering or permissions.

Requests use the SDK model's supported thinking levels. Session snapshots include the native header and entries, preserving compaction cut points; restoring a branch can append messages after its nearest snapshot. Context is emitted in `finally`, including when a prompt throws. Android persists terminal events independently of Activity lifetime. Pending-turn checks prevent a late UI preview from replacing final text or reviving a deleted conversation. A missing known native snapshot is reported instead of silently replaying text.

Models, resource diagnostics, OAuth prompts, credential updates, package operations and resource toggles use the SDK. Provider credentials are updated through the host's conflict-checked file store. npm/Git package sources require the corresponding runtime commands; local packages use app-accessible paths. Configured package paths are not proof that an extension loaded successfully.

## Bridge and packaging

The app starts Node once with private `HOME`/`TMPDIR` and exchanges request-ID-tagged newline JSON over a randomized abstract Unix socket. The connecting peer must match the app process UID and PID. Only one operation is admitted at a time; the protocol includes busy rejection, cancellation, errors and OAuth replies. Startup failure is sticky until process restart.

`scripts/prepare-pi-runtime.ps1` prepares Node Mobile 24.18.0-0, arm64 libraries/headers and npm dependencies. `npm run build` bundles `android.js` into `app/src/main/assets/pi-runtime.cjs` and copies the pinned SDK metadata, documentation, themes and export resources into `app/src/main/assets/pi-sdk/`. Both outputs are generated and ignored by Git. The bundle maps `import.meta.url`, sets `PI_PACKAGE_DIR`, and uses the pinned SDK's internal HTTP dispatcher bootstrap.

## Local verification

```sh
npm --prefix pi-runtime ci
npm --prefix pi-runtime test
```

The suite checks all 65 documented settings keys, wire-level thinking values, scoped resources, local package lifecycle, native history/compaction, session-only selection, cancellation and context publication after a throwing prompt. It also builds and executes the shipped CJS bridge with local mock SSE, TypeScript extensions/tools/providers, simulated OAuth and busy/abort/recovery checks. Mock credentials and replies are not real provider validation.

Run `scripts/verify.ps1` after the runtime suite for JVM tests, pure Java checks, APK assembly and lint. Instrumentation source compilation is separate from execution. This delivery deliberately does not run device/emulator tests; Windows Node/JVM success does not establish Android Node, real OAuth or npm/Git compatibility.
