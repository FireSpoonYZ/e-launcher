# Third-party source notices

Launcher Probe incorporates modified source from **Ogesture**, by the Ogesture contributors / team Olauncher:

- Repository: https://github.com/tanujnotes/Ogesture
- Exact revision: `404fb0a27a5e3122b153a4a97a150f31c3c04804`
- License: GNU Affero General Public License version 3, copied verbatim from upstream into [`LICENSE`](LICENSE).
- Modification date: 2026-09-09. This modified application is distributed under AGPL-3.0; it is not an official Ogesture release.

## Source mapping and modifications

| Upstream path (under `app/src/main/java/com/ogesture/`) | Local derived file (under `app/src/main/java/com/example/launcherprobe/`) | Changes |
| --- | --- | --- |
| `gesture/SwipeDetector.kt`, `data/Models.kt` | `SwipeDetector.java` | Java translation of fixed zones, direction/distance gates, timeout, anchor-based hold reset, short/long exclusion, sample collection and cancellation. Scheduling is supplied by the service's Handler so the same logic runs in host tests. Hold increased from 100 to 300ms; optional visual feedback removed. |
| `service/EdgeOverlayService.kt` | `GestureService.java` | Port of three-zone geometry (80% lengths, 16dp sides / 12dp bottom), navigation insets, display updates, held-stream interactivity, touch-path replay and 65ms settling grace. Uses physical LEFT/RIGHT rather than locale-relative START/END; API29 reads real display dimensions. Updates existing windows on geometry changes and cancels old detector callbacks. No indicators, haptics, configuration/exclusions, foreground service or watchdog. |
| `service/EdgeGestureAccessibilityService.kt` | `GestureService.java` | Global Back/Home/Recents and `dispatchGesture` callbacks. Checks failures and reports them. A single connected AccessibilityService owns trusted `TYPE_ACCESSIBILITY_OVERLAY` windows rather than a separate `TYPE_APPLICATION_OVERLAY` service. The original gesture path does not use window content; this application now separately exposes bounded accessibility-node observation/actions to its assistant. |

`NavigationSession.java` and the HyperOS `force_fsg_nav_bar` write/readback, recovery marker, App controls, host checks and verification script are additions for this project, not features supplied by upstream Ogesture. The accessibility XML uses the corresponding platform capabilities; no upstream UI/resources or Kotlin build stack were copied.

Network requests use [OkHttp 3.14.9](https://github.com/square/okhttp/tree/parent-3.14.9), Copyright 2019 Square, Inc., under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

The selected upstream source files contain no individual copyright headers. Their attribution is retained here and at the heads of the derived Java files; the Free Software Foundation copyright in the license text refers to that document, not authorship of Ogesture's code. No upstream license notice has been removed.

## Distribution

When conveying this APK, satisfy AGPLv3's corresponding-source requirements, including these modifications and the material needed to build them. A link to the unmodified upstream repository alone is not corresponding source for this APK. Preserve this notice and the complete license; consult `LICENSE` for the applicable source-delivery options and the network-interaction provisions if functionality later changes. This project makes no warranty of compatibility with a particular ROM.
