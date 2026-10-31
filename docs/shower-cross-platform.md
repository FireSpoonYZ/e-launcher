# Shower on Android, Windows and Linux

`shower` is one Host-side abstraction with three backends: the existing Android
virtual display, a Windows child RDP session, and a Linux private Xvnc `DISPLAY`.
The backends differ in what the platform can do, never in the API the model, the
runtime, the control API or the shared preview component use. Existing
`android_shower` keeps working as a compatibility path on the same Android
controller/owner mapping.

Architecture and the 2026-10-26 device acceptance results are recorded below.
The parent performed builds and device verification; implementation workers did
not run acceptance checks.

## One abstraction

- Protocol: `host-core/shower-protocol.js` + `.d.ts` define `ShowerTarget`,
  `ShowerActor`, `ShowerSession`, `ShowerFrame`, `ShowerInput`, `ShowerLaunch`,
  `ShowerFrameLimits`, `ShowerCreateOptions`, the normalizers and
  `SHOWER_ERROR_CODES`. Public data never carries platform handles or credentials.
- Backends: `shower-android.js`, `shower-windows.js`, `shower-linux.js` export
  `create*ShowerBackend` and implement the same `status/ensure/frame/input/launch/
  release/close` Promise methods. The Windows backend additionally exposes
  `prepare()`, the startup-only authorization entry: called once during Windows
  Host startup, it never creates a desktop. Other backends have no `prepare` and
  stay fully lazy — nothing instantiates them at startup. Backends depend on no
  Host or harness.
- Manager: `shower-manager.js` owns Actor binding, the random session id allocated
  before the first `ensure`, per-session serialization, cancellation that bypasses
  the queue, startup `prepare()`, and lazy native process start. A second owner on
  Windows gets `SHOWER_BUSY`. On Windows and Linux each session is released after
  a fixed 300 s of inactivity along that owner's FIFO: create/re-ensure, input,
  launch, human takeover cancel and agent frames renew the timer, while status and
  human preview frames do not. In-flight operations are never preempted (the
  release runs behind them and re-arms on completion), release/forget/close clear
  it, and a failed idle release keeps ownership so status or an explicit release
  can still settle it.
- Model surface: the durable extension `host.shower` exposes exactly six tool
  actions (`status`, `create`, `launch`, `screenshot`, `input`, `release`) from
  `shower-tools.js`, sequential, with `source:'agent'` and `taskId` attached by the
  Host. Human operations use `source:'human'` and a synthetic `human:` id; the model
  can never set either.
- Control surface: the typed v2 runtime/control methods `getShowerStatus`,
  `createShowerSession`, `getShowerFrame`, `sendShowerInput`, `takeoverShower`,
  `releaseShowerSession`, served as `POST /v1/shower/status|create|frame|input|
  takeover|release` behind the existing bearer + Origin checks. The four existing
  Tauri commands and sixteen ordinary broker ops stay unchanged; nothing here
  proxies arbitrary ports, shells or URLs.

Preview is bounded JPEG/PNG frames over the existing authenticated call, one
in-flight poll every 1000 ms while the view is visible, no background polling and
no video streaming.

## Capability differences

| | Android | Windows | Linux |
| --- | --- | --- | --- |
| environment | virtual display | child RDP session on this PC | private Xvnc `DISPLAY` |
| launch kinds | `app` | `process` | `process` |
| input kinds | click, drag, scroll, key, text | click, drag, scroll, key, text | click, drag, scroll, key, text |
| extra keys | `BACK`, `ANDROID_HOME` | – | – |
| native preview capability | false (shared frame preview) | true, via native preview modes | false (shared frame preview) |
| concurrent sessions | one per chat | one per machine | one per owning record |

Key names are `ENTER TAB ESCAPE SPACE BACKSPACE DELETE LEFT RIGHT UP DOWN HOME END
PAGEUP PAGEDOWN A..Z 0..9 F1..F12` plus the Android extras. Scroll deltas are
integer wheel notches in `-20..20`, positive Y down and positive X right; Android
maps vertical notches to a bounded swipe and reports `SHOWER_UNSUPPORTED` for a
direction it cannot express, exactly like an unsupported key. Nothing is
approximated silently.

Frame limits default to 1280x800 and 720*1024 base64 bytes, and the absolute control
result stays below the existing 1 MiB, so backends must resize or compress to meet
them (`SHOWER_FRAME_TOO_LARGE` if impossible). `width`/`height` are source input
pixels and `imageWidth`/`imageHeight` the encoded frame, so the UI can scale pointer
coordinates without guessing.

## Same user, no security boundary

All three backends run inside the Host user's own session and reuse that user's
programs, files and permissions. The environment is **not** a sandbox and not an
isolation boundary: a launched program or an injected input acts with the Host
user's rights, and the model, the human preview and the desktop share one account.
Do not describe Shower as a way to run untrusted code.

Credentials never travel over RPC: the Windows backend accepts them only through
the native Windows prompt, and no backend returns platform handles, tokens or file
contents for another session. Frames and inputs are only reachable through the
existing authenticated local-bearer / device-link control call.

## Takeover and abort

Human takeover is `takeoverShower`: the manager cancels the Actor's queued and
in-flight backend operations (`manager.cancel`), then awaits the existing
conversation abort used by `runtime.abort` — including the work conversation — and
returns the current status. There is no return-control button, control lease or
separate scheduler, and no persisted "stopped work" state that would need
`resumeWork`.

Partial input reports `unconfirmed` and is never replayed; a new user turn or a new
AI turn simply takes a fresh screenshot (tool instruction) and continues. Input sent
by the human arrives after the abort, so it cannot interleave with a queued tool
operation. Closing the preview stops polling, not the environment.

## Windows native host

### Build

The native host is a .NET Framework 4.8 x64 executable written in C# 5 syntax,
because the only compiler used is the in-box `Framework64\csc.exe`:

```powershell
npm --prefix host-core run build:shower-windows
# same as: node host-core/build-shower-windows.js
```

The script requires Windows, `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\
csc.exe` and the system `System32\mstscax.dll`. It does not use PowerShell, NuGet,
a Windows SDK, `tlbimp` or any downloaded package, and it fails with an explicit
message instead of falling back.

It compiles, in this order:

1. `host-core/native/windows/InteropGenerator.cs` → `native/windows/build/
   InteropGenerator.exe`.
2. That generator converts the system `mstscax.dll` type library into
   `native/windows/build/MSTSCLib.dll`. Referenced type libraries (stdole and
   anything else the control pulls in) are generated the same way from the same
   source, so no GAC Primary Interop Assembly is borrowed.
3. Every `*.cs` in `host-core/native/windows/` except `InteropGenerator.cs`
   (`Program`, `Wire`, `NativeHost`, `RdpHost`, `SessionAgent`, `AgentCapture`,
   `AgentInput`, `SessionBootstrap`, `BootstrapNative`, `BootstrapGuardian`, and any
   later sibling file) with `/langversion:5 /platform:x64`, referencing
   `MSTSCLib.dll` plus `System`, `System.Core`, `System.ServiceProcess`,
   `System.Security`, `System.Windows.Forms`, `System.Drawing` and
   `System.Web.Extensions` → `native/windows/build/shower-windows.exe`.

Outputs are build artifacts and git-ignored (`host-core/.gitignore`): a generated
interop assembly is never committed. A stale `shower-windows.exe` is deleted before
the host compile, so a failed build cannot leave an executable for the adapter to
spawn.

### Deployment

The native host is part of the Host runtime, not of the pure desktop client sidecar:
the Tauri desktop client only talks to the Host. Deploying means building once and
copying `shower-windows.exe` together with `MSTSCLib.dll` to the same directory on
the target machine; the Host's `shower-windows.js` adapter then spawns the fixed
path `host-core/native/windows/build/shower-windows.exe`, or an absolute
`E_LAUNCHER_SHOWER_WINDOWS_EXE` set by the operator. Neither the model nor the
client can override that path, and one Host owns one child process — an existing
child started by another application is never adopted.

### Runtime shape

`shower-windows.exe host --state-dir <abs path>` is the long-running Host process
(`RdpHost`): it owns the STA ActiveX control, the child session lifecycle and the
JSONL framing on stdin/stdout, with logs on stderr only and no input text or
passwords in logs. Internal invocations are `agent --pipe <name> --session-id <N>`
(run as `SessionAgent` on the child desktop) and `bootstrap-*` (handled by
`SessionBootstrap.Run`). Requests are
`{id,method:'prepare'|'ensure'|'status'|'frame'|'input'|'launch'|'release'|'preview'|'cancel',
params}` and responses `{id,ok:true,result}` or `{id,ok:false,error:{code,message,
outcome?}}`; an unsolicited `{event:'status',status}` is allowed. The native side
caps a frame at 2 MiB and receives the image base64 cap from the request. EOF
releases the owned session. `prepare` only runs `SessionBootstrap.EnsureEnabled`
(administrator approval plus the elevated guardian); `ensure` refuses to start a
session on a host that was not prepared during this process lifetime.

The control connects to localhost with CredSSP, `AuthenticationLevel=0` and
`ConnectToChildSession=true`; the child session id is validated before and after
connecting, and the phase stays `authentication-required` while the native prompt
waits, so a human login never blocks the RPC for 20 seconds. Native preview modes
are `visible`, `minimized`, `offscreen` and `hidden`; the default after login is
`hidden`, and an explicit preview request may show it. Real-machine capture and
input passed with the host visible, offscreen and hidden. Native minimization
failed input/capture, so `minimized` is implemented as `hidden`, and the native
window's minimize button is disabled.

### Bootstrap and cleanup

Windows startup authorization happens once per Host lifetime, at Host startup
(`manager.prepare()`), not on the first screen. The native `prepare` command runs
`SessionBootstrap.EnsureEnabled`: the single administrator approval enables child
sessions, starts TermService if needed, records the restore baseline and starts an
elevated guardian. A cancelled or failed preparation aborts Host startup and the
native host exits, so nothing pretends the remote screen is ready. The guardian
accepts only fixed executor-launch requests for its own Host PID/start time,
parent/child session and user. The existing temporary SYSTEM task performs token
validation and starts the child's **non-elevated** executor. `WTSQueryUserToken`
remains in that SYSTEM step; an administrator token alone is insufficient.

Session creation never elevates: the remote-UAC call was removed from the RDP
session start, and if the authorized host or guardian is lost (host restarted,
guardian exited) `ensure`/launch fails explicitly asking for a Host restart —
input or clicks never trigger a hidden re-elevation.

Successful `release` (explicit or idle expiry) sends a non-blocking
`WTSLogoffSession` for the owned child and confirms the child id disappears (or
leaves the logged-on state) within a bounded ~8 s poll — it never reports
released while the child may still exist, and retains the native Host, ActiveX
control and guardian, so subsequent creation within the same Host needs no new
approval. A failed release
or Host shutdown terminates the native process; the guardian restores the
original child-enabled and TermService state. NLA, Windows Hello, firewall and
`RDP-Tcp` settings are not changed.

### Local Windows credential enrollment

Microsoft documents automatic parent-user logon for normal
[child sessions](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions).
On the acceptance machine, the Microsoft-account/Hello session instead returned
RDP error 2055 (`SSL_ERR_LOGON_FAILURE`). Changing account hints, removing
CredSSP, or retaining only ActiveX memory did not provide unattended recreation.

At the operator's explicit request, Windows credentials are now enrolled in a
native `CredUIPromptForWindowsCredentialsW` dialog. Use the prefilled current
Windows account and its account password. The password is committed **only after**
RDP logon and the child-user ownership check succeed, via `CredWriteW` under the
generic target **`e-launcher/Shower/localhost`**, with
`CRED_PERSIST_LOCAL_MACHINE`. This is the current user's local credential vault,
not a roaming credential, center setting or application JSON file. Each connection
reads it with `CredReadW` and supplies it directly to the ActiveX password property.
Temporary native buffers are cleared; no password is included in Node IPC, tool
results, command arguments or logs.

The vault follows Windows user-account permissions: it is not isolation from other
processes running as the same user. Manage or remove the entry in Windows
**Credential Manager → Windows Credentials → Generic Credentials**. Deleting it
causes local enrollment on the next creation. A rejected or expired password is
re-entered locally on a subsequent release/create and replaces the old value only
after successful validation.

After enrollment, creation and recreation within a running Host require neither a
password prompt nor another UAC. A newly started Host still needs one administrator
approval; its password is restored from the vault. An existing interactive Windows
user session is required; a machine reboot left at the sign-in screen is a separate
scenario. Desktop startup is probed for up to 30 seconds before reporting an
unavailable/secure desktop, rather than treating the initial Winlogon transition
as a new password requirement.

API references: [Credential UI](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creduipromptforwindowscredentialsw),
[CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew),
[WTSQueryUserToken](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken),
[WTSLogoffSession](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtslogoffsession).

## Linux provider

The Linux backend (`shower-linux.js`) starts `Xvnc` on a private `DISPLAY` with its
own `XAUTHORITY`, runtime directory and `dbus-daemon` session bus. It starts a
lightweight window manager, `xfdesktop` for the desktop background and
`xfce4-panel` with an applications menu and window task list. Desktop components
use a session-private configuration directory with a preconfigured panel and
configuration version, avoiding the first-run panel dialog and changes to the
physical desktop configuration. Workspace 0 on the `VNC-0` monitor defaults to a
solid dark blue-gray background; other monitor names are not covered by that
background setting. The XFCE terminal helper defaults to `xfce4-terminal`.
`WAYLAND_DISPLAY` and the physical XSMP `SESSION_MANAGER` are not inherited; the
physical D-Bus session address is replaced by the private bus. It never uses
`x0vncserver` or any shadow of the physical desktop, and cleans up only resources
it started.

Required system programs, which must already be installed (the backend reports an
explicit dependency error and never installs packages):

- `Xvnc` or `Xtigervnc`
- a window manager: `xfwm4` or `openbox`
- `xfdesktop` and `xfce4-panel`, including the applications menu and task list
  plugins and XFCE configuration service
- `xfce4-terminal` (the desktop terminal helper)
- `xdotool` (input), `ffmpeg` with `x11grab` (frame encoding), `xauth`, `dbus-daemon`

Ready requires a responsive private display, a running window manager and visible
`xfdesktop` and `xfce4-panel` windows; key component exits are reported as errors.
This does not use black pixels as a failure condition, nor does it prove that the
panel plugins are usable. Launch uses argument arrays, never shell strings. An optional noVNC view may only
listen on localhost behind the existing authenticated route; no unauthenticated
remote port is opened.

Acceptance must run on a real Linux desktop machine, not on WSL: WSL has no X
server of its own and no real seat, so a WSL result proves nothing about the Xvnc,
window manager and input path. The historical Linux results below predate the
lightweight desktop changes and do not constitute their acceptance. Keep the target address for that check documented
here (for example `ssh <user>@<linux-desktop-host>`) and never store keys,
passwords or tokens for it in the repository.

## Lifecycle and errors

`release` (explicit end-session, 300 s idle expiry on Windows/Linux or owning Host
shutdown) tears down only the record it owns; `backend.close()` is idempotent and
cleans up only resources the backend created. Closing a preview, an AI abort or a
new turn never destroys the environment, and a screenshot never silently resizes
or recreates a desktop.

Error codes are the shared set: `SHOWER_UNAVAILABLE`, `SHOWER_UNSUPPORTED`,
`SHOWER_BUSY`, `SHOWER_AUTH_REQUIRED`, `SHOWER_PERMISSION_REQUIRED`,
`SHOWER_SESSION_NOT_FOUND`, `SHOWER_SESSION_MISMATCH`, `SHOWER_NOT_READY`,
`SHOWER_INPUT_FAILED`, `SHOWER_FRAME_TOO_LARGE`, `SHOWER_BACKEND_FAILED`, plus the
existing `INVALID_ARGUMENT`/`CANCELLED`. Input keeps the existing not-sent /
unconfirmed / responded outcome semantics and is never retried automatically; a
session id from another session or Actor is rejected instead of acted on.

## Android retention

The legacy server still reclaims an idle display after 300 seconds. A successful
unified surface ensure starts one Host-owned native timer, which touches only
already-bound, live surfaces every 60 seconds. It never starts Shizuku, reconnects
or recreates a lost display. Release clears the binding; Host shutdown stops the
timer and releases its controllers. Legacy-only displays keep their existing
idle policy. This is independent of preview frame polling.

## Device acceptance — 2026-10-26

| Check | Observed result |
| --- | --- |
| Windows native build | Framework C# 5 / x64 and locally generated COM interop compiled successfully. |
| Windows child session | Session 8, non-elevated executor, capture/click/text/Chinese input passed. |
| Windows visibility | Visible, offscreen and hidden input/capture passed; sampled primary desktop cursor, foreground and focus stayed unchanged. Native minimization failed, hence the hidden-mode mapping. |
| Windows release | Authenticated WSS release succeeded; native host, agent and guardian exited. Read-back: child sessions disabled, no child session, TermService stopped. |
| Linux | Ubuntu 26.04 via SSH, private Xvnc :100 with private D-Bus, screenshot and confirmed GUI text input passed without a VNC viewer. |
| Takeover cancellation | Windows and Linux in-flight drags returned CANCELLED; the same environment remained ready. |
| WSS remote control | TLS relay + registered Windows/Linux device links + separate authenticated client. Remote frames/input passed, with application-side text evidence; Linux takeover and both releases passed. |
| Android | Redmi 25102RKBEC / Android 17: virtual display, frame, click, Chinese text, takeover and shared preview passed. |
| Android input UI | Device WebView CDP sent A, B and an IME commit; exactly three native text requests and actual Settings text AB中. Input field cleared after each submission. |
| Android retention | With the app in the background and no preview requests, the same session remained ready for about 29 minutes. Explicit release removed the display; status returned idle. |
| Builds | Android APK, Web build, desktop TypeScript, and Windows native build passed. |

Evidence is outside the repository in the local temporary directory
`desktop-shower-development-1793002760507/e2e`. Test Host/device-link/relay
processes and tunnels are stopped after verification; test credentials are removed.

## Deployment and real-model acceptance — 2026-10-27

The relay is deployed at `wss://relay.firespoon.cn:3000/v1/link`, behind the
existing Ferron TLS gateway. Linux relay and Host services are enabled through
systemd. Windows has a persistent Host directory and a manual start script.
The existing Pi configuration was converted into 77 chat models and 10 provider
declarations, with credential environment aliases. Devin had no explicit or
cached model list and remains empty. Pi Durable stays pinned to 1.3.0.

All model-driven checks below used `antigravity/gemini-3.8-flash-high` with
`thinkingLevel: high`, through the deployed authenticated WSS relay.

| Environment | Real execution evidence |
| --- | --- |
| Windows child session 9 | Model launched the WinForms verification app through shower, read screenshots and entered Chinese text. The first button coordinate missed; after counter feedback the model re-read the image and triggered the button (application counter 1). |
| Linux Xvnc | Model launched GTK zenity through shower, entered `LINUX_REAL_MODEL_中文_20261026` through GUI input, and confirmed it. The application output file matched; the model also used read to verify that file. |
| Redmi K90 Pro Max / Android 17 | Model launched Android Settings on the virtual display, scaled image coordinates to source pixels and entered `MYRON_REAL_20261027`; an independent frame confirmed it. |
| Android 16 / API 36 x86_64 emulator | Existing AVD probe36, no data wipe. Model created a 1088×2400 virtual display, launched Settings and entered `EMULATOR_REAL_20261027`; independent capture confirmed it. |

On each environment, takeover aborted a genuinely active model turn
(`unanswered / aborted`), preserved the same environment, and the next turn
read a new human-entered marker from a fresh screenshot. The emulator additionally
passed a native touch through the local preview, text input, preview close and
model continuation reading `EMU_HUMAN_62_UI`.

K90's actual Tauri UI displayed Windows and Linux frames through the production
relay. Its takeover button stopped a Windows model turn; text input reached the
Windows app exactly once. Linux text and Enter sent from the same preview produced
`HUMAN_接管_246810_UI_LX` in the application output.

Device testing exposed and fixed two shared UI issues: repeated client init
returned an old UI snapshot after profile saves, and chat rendering ignored the
live history/generation fields while remote receipt polling was missing. The final
emulator APK showed old and new remote answers, observed local streaming text,
returned to idle after completion, and kept cleared history hidden on reopening.
The clear-view preference was restored after this check.

The final builds cover ARM64 and x86_64 Android, Web, desktop TypeScript and the
Windows native host. APK paths:
- `app/build/outputs/apk/debug/app-debug.apk` — ARM64
- `app/build/outputs/acceptance/app-debug-x86_64.apk` — emulator

Detailed artifacts are outside the repository under
`desktop-shower-development-1793002760507/deployment`.
Windows/Linux/K90 test displays were released; Windows child-session enablement
and TermService were read back at their original disabled/stopped state.
K90's temporary screen timeout was restored to 600000 ms.

The other physical phone (zorn / 24117RK2CC) remained disconnected, so its
configuration was not changed. At the user's request, remaining device-side
verification used the emulator. K90 was tested before the last chat UI fix and
can receive the final ARM64 APK when reconnected. Linux's physical seat was a GDM
greeter; mobile checks used device automation, not physical fingers.
Per-application compatibility work, Xpra and Wayland remain outside this change.
