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

## Pi runtime

The Android Pi runtime bundles `@earendil-works/pi-coding-agent`, `pi-agent-core` and `pi-ai` at version **0.85.1**, together with their transitive dependencies. The Pi packages identify their license as **MIT** and their author as Mario Zechner; source is available at https://github.com/earendil-works/pi. Exact npm dependency versions and source locations are recorded in `pi-runtime/package-lock.json`. The build retains bundled legal comments and copies SDK resources from the pinned npm package. Generated SDK assets and the JavaScript bundle are reproduced by `pi-runtime/build.js`, not maintained as separate source copies.

The APK also includes the complete official **npm 11.6.2** distribution and its bundled dependencies, fetched from `https://registry.npmjs.org/npm/-/npm-11.6.2.tgz` with the exact SHA-512 integrity recorded in `pi-runtime/package-lock.json` and checked by `scripts/prepare-pi-runtime.ps1`. npm identifies its license as **Artistic License 2.0**; its `LICENSE` file and bundled dependency notices are retained inside the versioned npm payload. Source is available at https://github.com/npm/cli/tree/v11.6.2.

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
