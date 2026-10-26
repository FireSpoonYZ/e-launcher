# Shower on Android, Windows and Linux

`shower` is one Host-side abstraction with three backends: the existing Android
virtual display, a Windows child RDP session, and a Linux private Xvnc `DISPLAY`.
The backends differ in what the platform can do, never in the API the model, the
runtime, the control API or the shared preview component use. Existing
`android_shower` keeps working as a compatibility path on the same Android
controller/owner mapping.

Nothing in this document is an acceptance result. All real-machine behaviour
described here (window visibility, child session login, input injection, Xvnc
frame content) still has to be executed and accepted by the parent.

## One abstraction

- Protocol: `host-core/shower-protocol.js` + `.d.ts` define `ShowerTarget`,
  `ShowerActor`, `ShowerSession`, `ShowerFrame`, `ShowerInput`, `ShowerLaunch`,
  `ShowerFrameLimits`, `ShowerCreateOptions`, the normalizers and
  `SHOWER_ERROR_CODES`. Public data never carries platform handles or credentials.
- Backends: `shower-android.js`, `shower-windows.js`, `shower-linux.js` export
  `create*ShowerBackend` and implement the same `status/ensure/frame/input/launch/
  release/close` Promise methods. Backends depend on no Host or harness.
- Manager: `shower-manager.js` owns Actor binding, the random session id allocated
  before the first `ensure`, per-session serialization, cancellation that bypasses
  the queue, and lazy native process start. A second owner on Windows gets
  `SHOWER_BUSY`.
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
| native preview | yes (in-app preview) | yes, via native preview modes | optional local noVNC only |
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
`{id,method:'ensure'|'status'|'frame'|'input'|'launch'|'release'|'preview'|'cancel',
params}` and responses `{id,ok:true,result}` or `{id,ok:false,error:{code,message,
outcome?}}`; an unsolicited `{event:'status',status}` is allowed. The native side
caps a frame at 2 MiB and receives the image base64 cap from the request. EOF
releases the owned session.

The control connects to localhost with CredSSP, `AuthenticationLevel=0` and
`ConnectToChildSession=true`; the child session id is validated before and after
connecting, and the phase stays `authentication-required` while the native prompt
waits, so a human login never blocks the RPC for 20 seconds. Native preview modes
are `visible`, `minimized`, `offscreen` and `hidden`; the default after login is
`hidden`, and an explicit preview request may show it. Whether the window is truly
hidden must be checked on a real machine — that acceptance has not been run.

### Bootstrap and cleanup

The prior failure was `1314` (`SeAssignPrimaryToken` missing) when an elevated
process copied the child explorer token. The bootstrap therefore uses a temporary
elevated/SYSTEM one-shot helper (for example a task) that calls `WTSQueryUserToken`
and `CreateProcessAsUser` on `winsta0\default` to start the child user's
**non-elevated** executor. The helper accepts only a fixed executable and fixed
arguments, verifies that the resulting child session belongs to the initiating
parent/user, is deleted by name after use and is bounded in startup time. There is
no permanent service, account or password collection.

`EnsureEnabled` records the initial child-enabled and TermService state, and a
guardian restores it when the owning native host exits. NLA, Windows Hello,
firewall and `RDP-Tcp` settings are not toggled.

### Login is not free

Observed while developing this backend: the PIN bound to the parent, and the first
enable needed authentication; a valid Microsoft password initially failed over NTLM;
`runas` with the local password followed by the same password prompted explicitly
succeeded. So a passwordless or silent child login is **not** guaranteed, and the
`runas` comparison is not a general passwordless mechanism — it is a one-off
observation on one machine. Never automate `runas` credential entry, and never
claim that silent login works.

## Linux provider

The Linux backend (`shower-linux.js`) starts `Xvnc` on a private `DISPLAY` with its
own `XAUTHORITY` under `dbus-run-session`. It never uses `x0vncserver` or any shadow
of the physical desktop, and it only owns the PID/port it started.

Required system programs, which must already be installed (the backend reports an
explicit dependency error and never installs packages):

- `Xvnc` or `Xtigervnc`
- a window manager: `xfwm4` or `openbox`
- `xdotool` (input), `ffmpeg` (frame encoding), `xauth`, `dbus-run-session`

Launch uses argument arrays, never shell strings. An optional noVNC view may only
listen on localhost behind the existing authenticated route; no unauthenticated
remote port is opened.

Acceptance must run on a real Linux desktop machine, not on WSL: WSL has no X
server of its own and no real seat, so a WSL result proves nothing about the Xvnc,
window manager and input path. Keep the target address for that check documented
here (for example `ssh <user>@<linux-desktop-host>`) and never store keys,
passwords or tokens for it in the repository.

## Lifecycle and errors

`release` (explicit end-session or owning Host shutdown) tears down only the record
it owns; `backend.close()` is idempotent and cleans up only resources the backend
created. Closing a preview, an AI abort or a new turn never destroys the
environment, and a screenshot never silently resizes or recreates a desktop.

Error codes are the shared set: `SHOWER_UNAVAILABLE`, `SHOWER_UNSUPPORTED`,
`SHOWER_BUSY`, `SHOWER_AUTH_REQUIRED`, `SHOWER_PERMISSION_REQUIRED`,
`SHOWER_SESSION_NOT_FOUND`, `SHOWER_SESSION_MISMATCH`, `SHOWER_NOT_READY`,
`SHOWER_INPUT_FAILED`, `SHOWER_FRAME_TOO_LARGE`, `SHOWER_BACKEND_FAILED`, plus the
existing `INVALID_ARGUMENT`/`CANCELLED`. Input keeps the existing not-sent /
unconfirmed / responded outcome semantics and is never retried automatically; a
session id from another session or Actor is rejected instead of acted on.

## Still to be accepted on hardware

Not verified by this document and not to be reported as passing:

- Windows build (generator compile, interop generation, host compile) and a real
  child session login, window hidden-by-default behaviour, frame content and input
  in the child desktop, guardian restore of the recorded state.
- Linux Xvnc startup with the dependency set above, window manager, frame capture
  and input, on a real non-WSL machine.
- Shared preview component polling, takeover and abort over the v2 control methods
  on each platform, and the Android legacy `android_shower` path after the unified
  manager was introduced.
