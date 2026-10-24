# Third-party source notices

## Historical Ogesture derivation

Earlier Launcher Probe versions incorporated modified source from **Ogesture**, by the Ogesture contributors / team Olauncher:

- Repository: https://github.com/tanujnotes/Ogesture
- Exact revision: `404fb0a27a5e3122b153a4a97a150f31c3c04804`
- License: GNU Affero General Public License version 3, copied verbatim from upstream into [`LICENSE`](LICENSE).
- Original modification date: 2026-09-09. This application remains distributed under AGPL-3.0; it is not an official Ogesture release.

The standalone-assistant migration removes the derived `SwipeDetector.java` and `GestureService.java`, including the fixed navigation zones, accessibility overlays and touch replay. The former mappings were `gesture/SwipeDetector.kt` / `data/Models.kt` to `SwipeDetector.java`, and `service/EdgeOverlayService.kt` / `service/EdgeGestureAccessibilityService.kt` to `GestureService.java`. These are historical attributions, not a statement that the current APK includes that gesture implementation.

The project-added `NavigationSession.java` and accessibility configuration are also removed. `LegacyNavigationRecovery` is project migration code: only a retained pending-restore marker permits writing and verifying the old stop value (`force_fsg_nav_bar=0`). It neither recreates navigation gestures nor enables accessibility services. The project license and historical attribution are retained; no license file is deleted by this migration.

## Operit Shower

The application incorporates and modifies **Operit Shower**, by the Operit contributors:

- Repository: https://github.com/AAswordman/Operit
- Exact revision: `b2c76100e5960a82ec154b62f201d89db099fadc`
- Upstream paths: `showerclient/` and `tools/shower/app/src/main/`
- License: GNU Lesser General Public License version 3; a verbatim copy is retained at [`licenses/Operit-LGPL-3.0.txt`](licenses/Operit-LGPL-3.0.txt).

The required corresponding source is kept in this repository rather than represented only by a prebuilt upstream artifact:

| Upstream source | Local source | Changes |
| --- | --- | --- |
| `showerclient/.../ShowerController.kt`, `ShowerBinderRegistry.kt` | `app/src/main/java/com/example/launcherprobe/ShowerController.java`, `ShowerManager.java` | Java host integration using the existing Shizuku permission channel and one controller-owned virtual display. Adds authenticated Binder handoff, strict coordinates, real error propagation and explicit release. |
| `showerclient/.../ShowerServerManager.kt` | `OwnPermissionService.java`, `ShowerManager.java` | Replaces `/sdcard/Download/Operit`, broad `pkill`, Kotlin coroutines and a separate permission framework. The existing UID-checked UserService copies the generated asset directly to an app-owned `/data/local/tmp/e-launcher-shower-<uid>` directory, tracks and stops only its validated PID, and waits asynchronously for Binder handoff. |
| `showerclient/.../IShowerService.java`, `ShowerBinderContainer.java` | `app/src/main/aidl/com/ai/assistance/shower/IShowerService.aidl`, `app/src/main/java/com/ai/assistance/shower/ShowerBinderContainer.java` | Equivalent Binder contract converted to AIDL and narrowed to used functions. Screenshots use `ParcelFileDescriptor` instead of Binder byte arrays. The parcelable container and broadcast action/key stay protocol-compatible. |
| `tools/shower/app/src/main/java/com/ai/assistance/shower/` | `shower-server/src/main/` | Binder-only server with no Compose/video UI dependencies. Keeps Operit's virtual-display, capture, hidden-API workaround and display-scoped input implementation; enforces the host UID, forbids display 0, owns only one display, scales captures before PNG encoding, returns screenshot pipes, reports launch/input failures, sends swipe events at their actual timestamps, checks per-call Binder cancellation between gesture events, and exits only when no display is active. |
| `showerclient/src/main/assets/shower-server.jar` | `shower-server/build.gradle`, `app/build.gradle` | The 1.08 MiB upstream prebuilt artifact is not copied. Gradle reproducibly builds the modified, source-present server APK and packages it under the expected `shower-server.jar` asset name. |

`pi-runtime/shower.js` and the call-ID transport in `pi-runtime/android.js` are original host adapter code. Upstream's video renderer/surface UI, WebSocket/Python tools, Compose dependencies and coroutine client are not included. The task-detail preview is an original Java `TextureView` integration: the Binder contract now also accepts a viewer-owned `Surface` and display-scoped `MotionEvent` input. The server switches the existing virtual display to that local Surface and restores its original Surface on detach or viewer death; no upstream video UI or scrcpy code is bundled.

Network requests use [OkHttp 3.14.9](https://github.com/square/okhttp/tree/parent-3.14.9), Copyright 2019 Square, Inc., under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

The pi.dev package catalog is parsed with [jsoup 1.21.2](https://jsoup.org/), Copyright Jonathan Hedley, under the [MIT License](https://jsoup.org/license).

The selected upstream source files contain no individual copyright headers. Attribution for retained derived sources is kept here and at their Java file headers; historical removed-source mappings are documented above; the Free Software Foundation copyright in the license text refers to that document, not authorship of Ogesture's code. No upstream license notice has been removed.

## China mainland holiday arrangements

The APK includes a transformed, manually verified **2026** snapshot from
[NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn), pinned to
commit `dcecbce230a57639cc8967ec9e2465e744880fd8` (2025-11-04).
Copyright (c) 2019 NateScarlet; MIT license retained verbatim in
[`app/src/main/assets/cn-holidays-LICENSE.txt`](app/src/main/assets/cn-holidays-LICENSE.txt).
The snapshot retains the source commit, annual coverage, actual dates (including
adjacent-year entries), and the State Council notice:
https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm .
Only the verified annual coverage is treated as official; empty future-year
placeholders are rejected. Unlisted dates use ordinary weekdays/weekends, while
listed holiday and makeup-work dates override them. This is scheduling of all
days off, not a wage-multiplier or statutory festival-day calculation.

After verifying a new full annual notice, maintainers update the pinned snapshot
with `node scripts/update-cn-holidays.mjs <commit> <year...> --verified` and ship an
app update. The script checks format, dates, annual coverage, sources and conflicts;
the explicit verification flag records the required human completeness check.
The app additionally refreshes the current and next year in the background, at most
once daily, from the same repository's GitHub HTTPS contents API. Valid annual data
is atomically cached in private storage and takes precedence over the bundled year;
the cache records the actual request URL, Git blob SHA (not a commit SHA), and fetch
time. Empty placeholders and invalid responses never replace valid data. Opening or
editing statutory schedules and statutory alarm delivery provide refresh opportunities.
Alarm calculations never wait for HTTP; failed updates retain cached/bundled data,
and unknown years remain explicitly downgraded to fixed weekdays/weekends.

## Pi runtime

The Android Pi runtime bundles `@earendil-works/pi-coding-agent`, `pi-agent-core` and `pi-ai` at version **1.1.0**, together with their transitive dependencies. The Pi packages identify their license as **MIT** and their author as Mario Zechner; source is available at https://github.com/earendil-works/pi. Exact npm dependency versions and source locations are recorded in `pi-runtime/package-lock.json`. The build retains bundled legal comments and copies SDK resources from the pinned npm package. Generated SDK assets and the JavaScript bundle are reproduced by `pi-runtime/build.js`, not maintained as separate source copies. The runtime includes `@silvia-odwyer/photon-node` **0.3.4** (Rust/WASM image processing, **Apache-2.0**, https://github.com/silvia-odwyer/photon); its `photon_rs_bg.wasm` is packaged beside the runtime/resize worker and its license is copied to `assets/pi-sdk/PHOTON_LICENSE.md`. QuickJS WASM and the separate codemode worker are also packaged; exact dependency versions/licenses remain in the lockfile.

The APK also includes the complete official **npm 11.6.2** distribution and its bundled dependencies, fetched from `https://registry.npmjs.org/npm/-/npm-11.6.2.tgz` with the exact SHA-512 integrity recorded in `pi-runtime/package-lock.json` and checked by `scripts/prepare-pi-runtime.ps1`. npm identifies its license as **Artistic License 2.0**; its `LICENSE` file and bundled dependency notices are retained inside the versioned npm payload. Source is available at https://github.com/npm/cli/tree/v11.6.2.

## Bundled todo extension

The app's [todo extension](pi-runtime/extensions/todo/index.js) is adapted from
**@juicesharp/rpiv-todo 2.13.5**, Copyright (c) 2026 juicesharp, MIT License.
Upstream: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo.
The original license is retained in [LICENSE](pi-runtime/extensions/todo/LICENSE)
and copied into the APK as `assets/pi-sdk/RPIV_TODO_LICENSE.txt`.
The fork retains the tool actions, task fields, transitions, dependency checks and
`rpiv-todo-state` custom entries. It removes terminal-only UI/configuration and
still replays this fork's older `e-launcher-todo` entries.
It is bundled for e-launcher and is not published as a separate package.

## Codex Horizon reference material

The voice appearance reference in `app/src/main/res/raw/voice_horizon.glsl` and
`voice_watercolor.webp` comes from the installed OpenAI Codex desktop distribution
26.908.9136.0, assets `app-initial-bcc2ff475eb6.js` (Horizon material) and
`watercolor-7f01d7071d0b.webp`. Attribution: OpenAI. The desktop distribution is not
the Apache-licensed Codex CLI repository. No open-source license or redistribution
grant for these desktop assets was established during the visual-reference work.
The Android adapter replaces the WebGL uniform block with individual GLES uniforms
and composites the material through this application's lowercase e mask.

## Distribution

When conveying this APK, satisfy AGPLv3's corresponding-source requirements, including these modifications and the material needed to build them. A link to the unmodified upstream repository alone is not corresponding source for this APK. Preserve this notice and the complete license; consult `LICENSE` for the applicable source-delivery options and the network-interaction provisions if functionality later changes. This project makes no warranty of compatibility with a particular ROM.

## Orca remote-terminal components

Source: https://github.com/stablyai/orca, commit `de8bffe24045b396212f4f63de8960ec8380ea07`.
MIT License, Copyright (c) 2026 Lovecast Inc. Adapted terminal input, key encoding, IME composition, gestures, Unicode width handling, shortcut mutations and native request tracking. Exact paths and changes: [ATTRIBUTION.md](web/src/RemoteTerminal/ATTRIBUTION.md) and [native adaptation](docs/remote-terminal-android.md). Full license: [LICENSE.orca](web/src/RemoteTerminal/LICENSE.orca).

The extracted xterm.js Kitty keyboard encoder uses the pinned `@xterm/xterm@6.1.0-beta.303` source and retains its [MIT license](web/src/RemoteTerminal/xterm/LICENSE).
## acp-kernel

The host-core uses **acp-kernel 0.0.101**, by ranxianglei,
for embedded in-context compression. The Android Host runtime now bundles this
package; its full license text is shipped in `bot-host/third-party-licenses.txt`
(generated by `host-core/build-android.js` from the installed package).

- Repository: https://github.com/ranxianglei/acp-kernel
- License: MIT, with the upstream "Attribution on Product Surfaces" additional
  term; the full text is retained verbatim at
  [`licenses/acp-kernel-MIT.txt`](licenses/acp-kernel-MIT.txt).

That additional term requires visible attribution on at least one of the
product's home page, documentation, or About/Credits/Acknowledgements page,
stating the product uses acp-kernel and linking to
https://github.com/ranxianglei/acp-kernel. For server-side or embedded uses
without a user-facing surface, carrying these notices in the shipped
documentation satisfies the term.

## ripgrep and fd (search tools)

The host-core installs pinned **ripgrep 15.1.0** (<https://github.com/BurntSushi/ripgrep>) and
**fd 10.3.0** (<https://github.com/sharkdp/fd>) into the host dataRoot to back the grep/find
tools. Both projects offer their software under the MIT License (ripgrep additionally offers the
Unlicense); host-core selects and preserves each project's MIT license. The upstream license texts
are not copied into this repository: `host-core/prepare-tools.js` extracts each official release
archive's `LICENSE-MIT` entry at install time and saves it beside the installed binary at
`<dataRoot>/tools/<platform>-<arch>/<name>-<version>/LICENSE-MIT`, so the exact upstream notice
accompanies the downloaded artifact. Binaries are fetched from the projects' official GitHub release
assets at pinned tags (`15.1.0`, `v10.3.0`), checked against PE/ELF headers, and installed with
atomic rename; installation results report sha256 fingerprints. Only Windows x64 has been exercised
so far.

For the Android Host, the same pinned source versions are built from their locked Cargo
crates (ripgrep 15.1.0 from crates.io sha256
`f388c4955f85477c28a8667355819844a06614b083c23517f0e86bd1d6d82b73`; fd-find 10.3.0
from crates.io sha256
`2fbf004b5bbdefab92e76237e2022c77842cdef5d3213fe09fd804e0474785db`) for the Android
NDK targets `aarch64-linux-android` (arm64-v8a) and `x86_64-linux-android` (x86_64), with
API 29 and 16KiB ELF page alignment, and packaged into the APK as jniLibs
`libhost_rg.so`/`libhost_fd.so` (ELF executables renamed for Android packaging/extraction, generated
by `host-core/prepare-android-tools.js`). fd is built with `--no-default-features` to avoid
jemalloc and shell-completion extras. Linux-musl release binaries are not used on Android
because they fail under the real app UID (exit 159). The upstream MIT notices of rg and fd are
copied from the verified source crates into `bot-host/third-party-licenses.txt`.

## Android Host runtime bundle

The APK's host runtime (`bot-host/host-runtime.mjs`) bundles `@earendil-works/chord`,
`@earendil-works/pi-ai` and `@earendil-works/pi-durable` at version **1.3.0**, and
`acp-kernel` **0.0.101**, together with the transitive dependencies actually included
in the bundle. Each included package's name, version and license text are emitted
at build time into the shipped `bot-host/third-party-licenses.txt` by
`host-core/build-android.js`; exact versions are pinned in
`host-core/package-lock.json`. Building the bundle uses the esbuild dev dependency
from `pi-runtime`; esbuild itself is not shipped. The host runtime is built from
the repository's own `host-core` sources, not from a third-party binary kit.

The published npm archives of `@earendil-works/chord`, `@earendil-works/pi-ai`
and `@earendil-works/pi-durable` at 1.3.0 do not include a LICENSE file, so
`host-core/build-android.js` uses the pinned in-repo upstream copy
[`licenses/pi-v1.3.0-MIT.txt`](licenses/pi-v1.3.0-MIT.txt) for these three
packages when their installed package lacks a license file. That copy is the
verbatim MIT license of the earendil-works/pi repository at tag `v1.3.0`
(https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/LICENSE, Copyright
(c) 2025 Mario Zechner), verified by the project reviewer; it covers all three
packages, which are published from the same upstream repository. Any other
bundled package without a license file still fails the build instead of
falling back to package metadata.

## ws (WebSocket)

The host-core depends on **ws 8.22.0**, the WebSocket client/server implementation for Node.js, under the MIT License:

- Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
- Copyright (c) 2013 Arnout Kazemier and contributors
- Copyright (c) 2016 Luigi Pinca and contributors

The full verbatim license is retained at [`licenses/ws-MIT.txt`](licenses/ws-MIT.txt). Source: https://github.com/websockets/ws

## Tauri Android UI (`:tauri_ui`, module 18)

The APK now also ships a second UI process built from this repository's own frontend
plus the pinned Tauri Android stack:

- **Rust**: `tauri` **2.12.5** and `wry` **0.57.0** (both Apache-2.0 OR MIT) with
  `tauri-build` **2.7.4** as build dependency, pinned in
  [`mobile/src-tauri/Cargo.toml`](mobile/src-tauri/Cargo.toml). The cdylib
  `libe_launcher_mobile.so` (crate `e-launcher-mobile`) and the wry/tauri Kotlin that
  their build scripts generate at compile time (`Rust.kt`, `WryActivity.kt`,
  `TauriActivity.kt`, ...) are compiled into app id `com.example.launcherprobe`. Their
  license texts come from whatever license files the crate archives contain, plus the
  explicit exact-version fallbacks listed below.
- **Kotlin runtime**: shipped through the Kotlin Gradle plugin 2.3.20
  (`kotlin-stdlib`, Apache-2.0).
- **AndroidX/JVM libraries added for the UI process**: `androidx.startup:startup-runtime`
  **1.2.0**, `androidx.lifecycle:lifecycle-process` **2.10.0**,
  `androidx.webkit:webkit` **1.12.0** and
  `com.fasterxml.jackson.core:jackson-databind` **2.15.3** (Apache-2.0).

Legal texts shipped inside dependency jars are handled by AGP's standard packaging
merge: `app/build.gradle` removes only the eight default-excluded paths
`/META-INF/LICENSE`, `/META-INF/LICENSE.txt`, `/META-INF/NOTICE`,
`/META-INF/NOTICE.txt`, `/LICENSE`, `/LICENSE.txt`, `/NOTICE`, `/NOTICE.txt` from
`android.packaging.resources.excludes` and adds the same paths to
`resources.merges`, so same-named files are concatenated instead of dropped. The
signature/MANIFEST default exclusions and `jniLibs.useLegacyPackaging` are untouched;
there is no `pickFirst` and no hand-written replacement text.

Scoped verification of that wiring: after deleting the generated SDK include, a full
dual-ABI `assembleDebug` + `assembleDebugAndroidTest` finished with exit 0 and the
include was regenerated byte-identically. The resulting APK adds only
`META-INF/LICENSE`, `META-INF/LICENSE.txt` and `META-INF/NOTICE`; every other entry of
the previously accepted APK (DEX, native libraries, all assets and resources) is
SHA-256 identical in a single-pass extraction in the same ZIP order. All eight
`META-INF/LICENSE`/`NOTICE` files from the four Jackson 2.15.3 dependencies are
present as full texts inside the merged entries, and zipalign `-P16` plus the original
signing pass. Remote GitHub Actions has still not been run, and this verification does
not cover it.

`host-core/build-mobile.js` writes the Rust dependency notices for the ABI cargo graph
actually built into the Gradle assets source root
`app/build/generated/assets/tauri/THIRD_PARTY_NOTICES.txt`; inside the APK that file is
the asset `THIRD_PARTY_NOTICES.txt` (there is no `tauri/` asset directory). It reuses
the exact-version fallbacks of `host-core/build-desktop.js`, including mappings that
already existed for the desktop graph (`alloc-stdlib@0.3.0`, `selectors@0.38.0`). Four
published crate archives in the Android graph omit a license file, so their declared
license texts are vendored verbatim in this repository:

| crate | declared license | vendored texts | provenance |
| --- | --- | --- | --- |
| `jni-sys-macros` 0.4.1 | MIT OR Apache-2.0 | `licenses/android/jni-sys-macros-0.4.1-MIT.txt`, `licenses/android/jni-sys-macros-0.4.1-Apache-2.0.txt` | `jni-rs/jni-sys` commit `64d77b7a5f119d7b55b4e2c169a4668067ff59e6`, crate `jni-sys-macros`; version and declaration proven by the published crate's `Cargo.toml` and `.cargo_vcs_info` |
| `ndk-context` 0.1.1 | MIT OR Apache-2.0 | `licenses/android/ndk-context-0.1.1-MIT.txt`, `licenses/android/ndk-context-0.1.1-Apache-2.0.txt` | `rust-windowing/android-ndk-rs` commit `10f2ba388fca20f7349996ebae26ccda7a6fda5c`, path `ndk-context`; version and declaration taken from the published crate's `Cargo.toml.orig` and `.cargo_vcs_info` (the remote manifest fetch failed, so no remote manifest was used) |
| `ndk` 0.9.0 | MIT OR Apache-2.0 | `licenses/android/ndk-49bbbba16c58-MIT.txt`, `licenses/android/ndk-49bbbba16c58-Apache-2.0.txt` | `rust-mobile/ndk` commit `49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25`, path `ndk`; repository root `LICENSE-MIT`/`LICENSE-APACHE` at that commit |
| `ndk-sys` 0.6.0+11769913 | MIT OR Apache-2.0 | the same two `ndk-49bbbba16c58-*` files through an explicit mapping | `rust-mobile/ndk` commit `49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25`, path `ndk-sys`; the workspace inherits the repository root declaration, so the entry maps explicitly to the same verified root texts (not a sibling or version-range fallback) |

The `jni-sys-macros` MIT text starts with `Copyright (c) 2015 The rust-jni-sys
Developers`. The MIT texts taken for `ndk`/`ndk-sys`/`ndk-context` from the repository
root contain no copyright line, and none was invented for them. The Apache text keeps
terms 1-9 and the APPENDIX. A bundled crate whose archive has no license file and that
has no exact fallback mapping still fails the build instead of falling back to package
metadata.
